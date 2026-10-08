// The blueprint compiler (add-workflow-blueprint-compiler): a pure function
// from a logical workflow blueprint to a validated, custom-identity manifest.
//
// The compiler is the only place the newest built-in tier's construction is
// reproduced: it inserts the triage-routing step, the stage gates and the
// per-step routing steps the same way `definitions/edges.ts` and
// `definitions/graphs/*.ts` do, pins exact step references, derives the policy
// from the blueprint's traits, and dry-compiles the result through the
// registry's structural validation (including the custom-definition
// invariants) without ever registering it.
//
// It reports diagnostics instead of throwing, so a model author can fix a
// blueprint: each diagnostic names the rule and the step or edge involved.
//
// Pure domain: no I/O, no clock, no registry mutation.
import { ContractFailure, decodeContract } from "../../contracts/decode.ts";
import {
	customDefinitionDigest,
	withCustomIdentity,
} from "../definitions/custom.ts";
import { withPerStepRouting } from "../definitions/edges.ts";
import { exactStepReferences } from "../definitions/steps.ts";
import type {
	WorkflowEdge,
	WorkflowFamilyTraits,
	WorkflowManifest,
	WorkflowRegistry,
} from "../registry.ts";
import { type BlueprintInput, BlueprintSchema } from "../schema.ts";
import {
	blueprintStepCatalogEntry,
	GATED_STAGES,
	isBlueprintStepId,
	isInternalStepId,
} from "./catalog.ts";
import { validateBlueprintReviews } from "./review.ts";

/** The widest logical graph any built-in family has (the fusion flow). A
 * blueprint may not exceed it: a shaped workflow is narrower than the widest
 * built-in, never a new axis. */
export const MAX_BLUEPRINT_STEPS = 13;
/** The built-in loop bounds top out at the registry's verification-round cap
 * (`registerBuiltins` accepts 1..20); no loop may ask for more. */
export const MAX_LOOP_ATTEMPTS = 20;
export const MAX_VERIFICATION_ROUNDS = 20;

/** The steps a run may legitimately begin with. Everything that follows a
 * review or delivers/closes — `core.delivery`, `core.archive`, `core.completed`,
 * `core.closed`, `core.developer-review`, `core.findings-review`,
 * `core.wiki-approval` — must never be an entry: a run started there would
 * skip the work and the review the blueprint exists to protect. */
const ALLOWED_ENTRY_STEPS: readonly string[] = Object.freeze([
	"core.plan",
	"fusion.plan",
	"fusion.consolidate",
	"core.plan-approval",
	"core.implementation",
	"core.triage",
	"core.verification",
	"core.rebase",
	"core.wiki",
]);

function isAllowedEntryStep(id: string): boolean {
	return ALLOWED_ENTRY_STEPS.includes(id);
}

/** The steps that plan: their presence is what a `planned` change identity
 * requires (`validateFamilyTraits` checks the artifacts, not this pairing). */
const PLANNER_STEP_IDS: readonly string[] = Object.freeze([
	"core.plan",
	"fusion.plan",
	"fusion.consolidate",
]);

export interface BlueprintDiagnostic {
	/** The rule that rejected the blueprint: `schema`, `internal-step`,
	 * `unknown-step`, `bounds.steps`, `review.implementation-review`,
	 * `compile`, … */
	readonly rule: string;
	readonly message: string;
	/** The offending path for a review violation, review rules only. */
	readonly path?: readonly string[];
}

export interface BlueprintSummary {
	readonly label: string;
	readonly rationale: string;
	/** The compiled manifest's steps, including the inserted internal ones. */
	readonly steps: readonly string[];
	readonly initial: string;
	readonly terminal: readonly string[];
	readonly stepCount: number;
	readonly edgeCount: number;
	/** The blueprint's declared round count. The compiler requires a
	 * `core.verification` `fix` edge whose loop bound equals this count, so the
	 * compiled definition's effective round cap is exactly this number. */
	readonly verificationRounds: number;
}

export type BlueprintCompilation =
	| {
			readonly ok: true;
			/** The authored manifest with its derived `custom.` identity, ready
			 * to store. */
			readonly manifest: WorkflowManifest;
			readonly definitionId: string;
			/** The compiled manifest digest the workflow pins (the
			 * `definitionDigest` of `StoredDefinitionIdentity`). */
			readonly digest: string;
			/** The content-address digest the stored row and the `custom.`
			 * identifier are keyed on (`customDefinitionDigest`); equal to
			 * `definitionId`'s address, distinct from `digest`. */
			readonly identityDigest: string;
			readonly summary: BlueprintSummary;
	  }
	| { readonly ok: false; readonly diagnostics: BlueprintDiagnostic[] };

/** Decode a blueprint against the single Effect Schema, surfacing a
 * `ContractFailure` the same way every other contract does. Unknown properties
 * are rejected: a mistyped field would otherwise be silently dropped from the
 * persisted manifest. */
export function decodeBlueprint(value: unknown): BlueprintInput {
	return decodeContract("workflow.blueprint", BlueprintSchema, value, {
		onExcessProperty: "error",
	}) as BlueprintInput;
}

/** Insert `id` immediately before `before`, returning the new entry step when
 * the inserted step now stands in front of it. */
function insertStep(
	steps: string[],
	before: string,
	id: string,
	entry: string,
): string {
	const index = steps.indexOf(before);
	if (index === -1)
		throw new Error(`internal: ${before} is not a declared step`);
	steps.splice(index, 0, id);
	return entry === before ? id : entry;
}

/** The step a gated stage's own approval leads to: `approve` where the stage
 * has one, otherwise the stage's `complete` successor's `approve`. That is the
 * node the gate's `skip` mirrors. */
function approvedSuccessor(
	edges: readonly WorkflowEdge[],
	stage: string,
): string | undefined {
	const approve = edges.find(
		(edge) => edge.from === stage && edge.outcome === "approve" && !edge.loop,
	);
	if (approve) return approve.to;
	const complete = edges.find(
		(edge) => edge.from === stage && edge.outcome === "complete" && !edge.loop,
	);
	if (!complete) return undefined;
	return edges.find(
		(edge) =>
			edge.from === complete.to && edge.outcome === "approve" && !edge.loop,
	)?.to;
}

/** Where a skipped verification round lands: the review gate when a developer
 * review exists (the gate decides whether the review itself runs), otherwise
 * the tail the round's findings review would approve into, otherwise where a
 * passing verification goes. The built-in verify family routes the skip to its
 * completion tail; this mirrors it. */
function verificationSkipTarget(
	steps: readonly string[],
	edges: readonly WorkflowEdge[],
): string | undefined {
	if (steps.includes("core.developer-review")) return "core.review-gate";
	if (steps.includes("core.findings-review"))
		return approvedSuccessor(edges, "core.findings-review");
	return edges.find(
		(edge) =>
			edge.from === "core.verification" &&
			edge.outcome === "pass" &&
			!edge.loop,
	)?.to;
}

/** The entry step: the first step no non-loop edge enters. */
function deriveInitial(
	steps: readonly string[],
	edges: readonly WorkflowEdge[],
): string | undefined {
	const entered = new Set(
		edges
			.filter((edge) => !edge.loop && edge.from !== edge.to)
			.map((edge) => edge.to),
	);
	return steps.find((id) => !entered.has(id));
}

/** The terminal steps: `core.closed` when present, otherwise the sinks. */
function deriveTerminal(
	steps: readonly string[],
	edges: readonly WorkflowEdge[],
): string[] {
	if (steps.includes("core.closed")) return ["core.closed"];
	const leaving = new Set(
		edges.filter((edge) => edge.from !== edge.to).map((edge) => edge.from),
	);
	return steps.filter((id) => !leaving.has(id));
}

/** Insert the triage-routing step exactly as the newest built-in tier does:
 * between implementation and triage, with the empty-role bypass to
 * verification and the verification gate's `skip-verification` outcome into
 * the round's skip target. */
function insertTriageRouting(
	steps: string[],
	edges: WorkflowEdge[],
	entry: string,
	diagnostics: BlueprintDiagnostic[],
): string {
	if (!steps.includes("core.triage")) return entry;
	if (!steps.includes("core.implementation")) {
		diagnostics.push({
			rule: "triage-routing",
			message:
				"core.triage requires core.implementation: the compiler routes implementation into triage",
		});
		return entry;
	}
	if (!steps.includes("core.verification")) {
		diagnostics.push({
			rule: "triage-routing",
			message:
				"core.triage requires core.verification: the empty-role bypass enters verification",
		});
		return entry;
	}
	const index = edges.findIndex(
		(edge) =>
			edge.from === "core.implementation" &&
			edge.outcome === "complete" &&
			edge.to === "core.triage",
	);
	const insertAt = index === -1 ? undefined : edges[index];
	if (!insertAt) {
		diagnostics.push({
			rule: "triage-routing",
			message:
				"core.triage must be reached from core.implementation complete; the compiler inserts the triage-routing step there",
		});
		return entry;
	}
	// Every accepted graph wires all three triage-route outcomes, because the
	// registered behavior can emit `skip-verification` whatever the pinned
	// version; a shape with no skip target is rejected rather than wedging.
	const skipTarget = verificationSkipTarget(steps, edges);
	if (skipTarget === undefined) {
		diagnostics.push({
			rule: "triage-routing",
			message:
				"core.triage has no target for the verification gate's skip-verification outcome; add core.developer-review, core.findings-review, or a core.verification pass edge",
		});
		return entry;
	}
	const moved = insertStep(steps, "core.triage", "core.triage-route", entry);
	edges[index] = { ...insertAt, to: "core.triage-route" };
	edges.push({
		from: "core.triage-route",
		outcome: "complete",
		to: "core.triage",
	});
	edges.push({
		from: "core.triage-route",
		outcome: "empty",
		to: "core.verification",
	});
	edges.push({
		from: "core.triage-route",
		outcome: "skip-verification",
		to: skipTarget,
	});
	return moved;
}

/** Insert the plan, review and wiki gates exactly as the newest built-in tier
 * does: the gate stands in front of its stage (so the stage is entered only
 * through the gate's `run`), and the gate's `skip` mirrors the stage's own
 * approval target. When the stage was the entry step the gate becomes it. */
function insertStageGates(
	steps: string[],
	edges: WorkflowEdge[],
	entry: string,
	diagnostics: BlueprintDiagnostic[],
): string {
	let moved = entry;
	for (const [stage, gate] of GATED_STAGES) {
		if (!steps.includes(stage)) continue;
		moved = insertStep(steps, stage, gate, moved);
		for (let index = 0; index < edges.length; index += 1) {
			const edge = edges[index];
			if (!edge || edge.loop || edge.to !== stage) continue;
			edges[index] = { ...edge, to: gate };
		}
	}
	for (const [stage, gate] of GATED_STAGES) {
		if (!steps.includes(stage)) continue;
		const successor = approvedSuccessor(edges, stage);
		if (successor === undefined) {
			diagnostics.push({
				rule: "stage-gate",
				message: `cannot place ${gate}: ${stage} has no approval target to skip to`,
			});
			continue;
		}
		edges.push({ from: gate, outcome: "run", to: stage });
		edges.push({ from: gate, outcome: "skip", to: successor });
	}
	return moved;
}

/**
 * Compile a blueprint into a validated manifest.
 *
 * Returns diagnostics (never throws for a blueprint-shaped failure) naming the
 * rule and the step or edge involved.
 */
export function compileBlueprint(
	registry: WorkflowRegistry,
	value: unknown,
): BlueprintCompilation {
	let blueprint: BlueprintInput;
	try {
		blueprint = decodeBlueprint(value);
	} catch (error) {
		if (error instanceof ContractFailure)
			return {
				ok: false,
				diagnostics: error.issues.map((issue) => ({
					rule: "schema",
					message: `${issue.path}: ${issue.message}`,
					path: [issue.path],
				})),
			};
		throw error;
	}

	const diagnostics: BlueprintDiagnostic[] = [];
	const steps = [...blueprint.steps];
	const declared = new Set(steps);

	// Membership: no internal step, no step outside the catalog.
	for (const id of steps) {
		if (isInternalStepId(id))
			diagnostics.push({
				rule: "internal-step",
				message: `blueprint step ${id} is internal; the compiler inserts routing, triage-routing and gate steps`,
			});
		else if (!isBlueprintStepId(id))
			diagnostics.push({
				rule: "unknown-step",
				message: `blueprint step ${id} is not in the blueprint step catalog`,
			});
	}
	if (declared.size !== steps.length)
		diagnostics.push({
			rule: "duplicate-step",
			message: "blueprint steps must be unique",
		});
	if (!steps.length)
		diagnostics.push({
			rule: "empty-steps",
			message: "blueprint must declare at least one logical step",
		});

	// The change identity and the graph's planner must agree: a planner picks
	// the change id (`planned`), and the workflow-id/none identities mean no
	// planner runs. `validateFamilyTraits` checks each trait against the
	// artifacts, not this pairing, so the compiler enforces it here.
	{
		const planner = PLANNER_STEP_IDS.find((id) => declared.has(id));
		const identity = blueprint.traits.changeIdentity;
		if (planner !== undefined && identity !== "planned")
			diagnostics.push({
				rule: "change-identity",
				message: `changeIdentity "${identity}" contradicts the planning step ${planner}; a graph with a planner must declare "planned"`,
			});
		else if (planner === undefined && identity === "planned")
			diagnostics.push({
				rule: "change-identity",
				message:
					'changeIdentity "planned" requires a planning step (core.plan, fusion.plan or fusion.consolidate)',
			});
	}

	// Bounds.
	if (steps.length > MAX_BLUEPRINT_STEPS)
		diagnostics.push({
			rule: "bounds.steps",
			message: `blueprint declares ${steps.length} logical steps; the built-in catalog tops out at ${MAX_BLUEPRINT_STEPS}`,
		});
	if (
		blueprint.verificationRounds < 1 ||
		blueprint.verificationRounds > MAX_VERIFICATION_ROUNDS
	)
		diagnostics.push({
			rule: "bounds.verification-rounds",
			message: `verificationRounds must be between 1 and ${MAX_VERIFICATION_ROUNDS}`,
		});

	// Edges.
	const seenEdgeKeys = new Set<string>();
	for (const edge of blueprint.edges) {
		const step = blueprintStepCatalogEntry(edge.from);
		const key = `${edge.from}:${edge.outcome}`;
		if (seenEdgeKeys.has(key))
			diagnostics.push({
				rule: "duplicate-edge",
				message: `duplicate edge ${key}`,
			});
		seenEdgeKeys.add(key);
		if (!declared.has(edge.from) || !declared.has(edge.to))
			diagnostics.push({
				rule: "unknown-edge-endpoint",
				message: `edge ${edge.from}/${edge.outcome}->${edge.to} names a step the blueprint does not declare`,
			});
		if (step && !step.outcomes.includes(edge.outcome))
			diagnostics.push({
				rule: "illegal-outcome",
				message: `illegal outcome ${edge.outcome} from ${edge.from}`,
			});
		if (edge.loop && edge.loop.maxAttempts > MAX_LOOP_ATTEMPTS)
			diagnostics.push({
				rule: "bounds.loop",
				message: `edge ${edge.from}/${edge.outcome}->${edge.to} declares ${edge.loop.maxAttempts} attempts; the built-in maximum is ${MAX_LOOP_ATTEMPTS}`,
			});
	}

	// The declared round count is the compiled definition's round budget: a
	// graph that verifies must carry the `core.verification` `fix` loop whose
	// bound is exactly that count, so the summary and the persisted definition
	// cannot disagree.
	if (steps.includes("core.verification")) {
		const fixEdge = blueprint.edges.find(
			(edge) => edge.from === "core.verification" && edge.outcome === "fix",
		);
		if (fixEdge === undefined)
			diagnostics.push({
				rule: "bounds.verification-rounds",
				message: `core.verification declares no fix edge, so verificationRounds ${blueprint.verificationRounds} describes no loop; add a fix edge with maxAttempts ${blueprint.verificationRounds}`,
			});
		else if (!fixEdge.loop)
			diagnostics.push({
				rule: "bounds.verification-rounds",
				message: `the core.verification fix edge must carry a loop bound of ${blueprint.verificationRounds}`,
			});
		else if (fixEdge.loop.maxAttempts !== blueprint.verificationRounds)
			diagnostics.push({
				rule: "bounds.verification-rounds",
				message: `edge core.verification/fix->${fixEdge.to} allows ${fixEdge.loop.maxAttempts} rounds but the blueprint declares verificationRounds ${blueprint.verificationRounds}`,
			});
	}

	if (diagnostics.length > 0) return { ok: false, diagnostics };

	// The derived entry, constrained to a step a run may begin with.
	const initial = deriveInitial(steps, blueprint.edges);
	if (initial === undefined) {
		return {
			ok: false,
			diagnostics: [
				{
					rule: "initial-step",
					message:
						"blueprint has no entry step: every step is entered by a non-loop edge",
				},
			],
		};
	}
	if (!isAllowedEntryStep(initial))
		return {
			ok: false,
			diagnostics: [
				{
					rule: "initial-step",
					message: `blueprint entry step ${initial} would start the run after the review chain or at a terminal step; start at a planning, implementation, verification or rebase step`,
				},
			],
		};

	// Human reviews, on the logical graph before any gate insertion, anchored
	// on the entry so a graph that starts downstream of the review chain is
	// rejected too.
	for (const violation of validateBlueprintReviews(steps, blueprint.edges, {
		entry: initial,
		delivery: blueprint.traits.delivery,
	}))
		diagnostics.push({
			rule: `review.${violation.rule}`,
			message: violation.message,
			path: violation.path,
		});
	if (diagnostics.length > 0) return { ok: false, diagnostics };

	const graphSteps = [...steps];
	const graphEdges: WorkflowEdge[] = blueprint.edges.map((edge) => ({
		from: edge.from,
		outcome: edge.outcome,
		to: edge.to,
		...(edge.loop ? { loop: { ...edge.loop } } : {}),
	}));

	let entry = insertTriageRouting(graphSteps, graphEdges, initial, diagnostics);
	entry = insertStageGates(graphSteps, graphEdges, entry, diagnostics);
	if (diagnostics.length > 0) return { ok: false, diagnostics };

	const terminal = deriveTerminal(graphSteps, graphEdges);
	if (!terminal.length) {
		return {
			ok: false,
			diagnostics: [
				{
					rule: "terminal-step",
					message:
						"blueprint has no terminal step (no core.closed and no sink)",
				},
			],
		};
	}

	const routed = withPerStepRouting({
		id: "blueprint",
		version: 1,
		label: blueprint.label,
		initial: entry,
		terminal,
		steps: graphSteps,
		edges: graphEdges,
	});
	// A fresh literal per compile: the effect is digest-covered content, so a
	// shared instance would let one definition's edit rewrite another's.
	const edges = routed.edges.map((edge) =>
		edge.from === "core.wiki-approval" &&
		edge.outcome === "approve" &&
		!(edge.effects && edge.effects.length > 0)
			? {
					...edge,
					effects: [
						{
							kind: "wiki.verify" as const,
							idempotencyKey: "wiki.verify",
							payload: {},
						},
					],
				}
			: edge,
	);

	// Exact references: the newest tier's triage-routing step is version 2
	// (its `skip-verification` outcome), everything else version 1.
	const stepRefs = exactStepReferences(routed.steps, {
		"core.triage-route": 2,
	});
	const versionOf = (id: string): number =>
		stepRefs.find((ref) => ref.id === id)?.version ?? 1;

	// Restrict a non-terminal step's outcomes to the ones its graph provides,
	// so a shape that deliberately omits an outcome (solo's `create-pr`) stays
	// legal without the author restating the catalog.
	const allowedOutcomes: Record<string, readonly string[]> = {};
	for (const id of routed.steps) {
		if (terminal.includes(id)) continue;
		let outcomes: readonly string[];
		try {
			outcomes = registry.step(id, versionOf(id)).outcomes;
		} catch {
			continue;
		}
		const present = outcomes.filter((outcome) =>
			edges.some((edge) => edge.from === id && edge.outcome === outcome),
		);
		if (present.length > 0 && present.length < outcomes.length)
			allowedOutcomes[id] = present;
	}

	// A delivering graph commits and pushes with `git add -A`, so it must never
	// start on top of pre-existing uncommitted work: `clean-tree` is derived
	// rather than trusted from the author.
	const delivering =
		graphSteps.includes("core.delivery") || graphSteps.includes("core.archive");
	const traits: WorkflowFamilyTraits =
		delivering && !blueprint.traits.startRequirements.includes("clean-tree")
			? {
					...blueprint.traits,
					startRequirements: [
						...blueprint.traits.startRequirements,
						"clean-tree",
					],
				}
			: blueprint.traits;

	const manifest = withCustomIdentity({
		id: "blueprint",
		version: 1,
		label: blueprint.label,
		initial: routed.initial,
		terminal,
		steps: routed.steps,
		edges,
		stepRefs,
		allowedOutcomes,
		policy: {
			targetKind: "repository",
			checkoutRequired: blueprint.checkoutRequired,
			requiresReadOnlyResearcher: false,
			traits,
		},
	});

	try {
		const compiled = registry.compileWorkflow(manifest);
		return {
			ok: true,
			manifest,
			definitionId: compiled.id,
			digest: compiled.digest,
			identityDigest: customDefinitionDigest(manifest),
			summary: {
				label: blueprint.label,
				rationale: blueprint.rationale,
				steps: compiled.steps,
				initial: compiled.initial,
				terminal: compiled.terminal,
				stepCount: compiled.steps.length,
				edgeCount: compiled.edges.length,
				verificationRounds: blueprint.verificationRounds,
			},
		};
	} catch (error) {
		return {
			ok: false,
			diagnostics: [
				{
					rule: "compile",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
}
