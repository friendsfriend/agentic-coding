import type { WorkflowSnapshot } from "../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import { effectiveFamilyTraits } from "../definitions/manifest-policy.ts";
import type { WorkflowFamilyTraits } from "../registry.ts";
import type { ArriveResult, StepBehavior } from "./types.ts";

// Single source of truth for the core.verification role catalog: the engine's
// selection validation, triage validation, and the dashboard preset editor all
// read this list. Each role resolves the pinned asset named
// `verification-<role without "-verifier">.md` (assignment.ts).
export const VERIFIER_ROLES = [
	"quality-verifier",
	"security-verifier",
	"performance-verifier",
	"openspec-verifier",
	"usability-verifier",
	"test-verifier",
	"concurrency-verifier",
	"migration-verifier",
	"test-quality-verifier",
] as const;
const TRIAGE_ROLES = VERIFIER_ROLES.filter((role) => role !== "test-verifier");

/** The focused check each verifier role is asked to perform, rendered as the
 * assignment's `## Required checks`. Every verifier's brief says "use only the
 * focused checks named for your role", so a placeholder there leaves the role
 * to improvise (six of nine verifiers ran no gate at all in the round this was
 * measured on) or to re-run the worker's whole gate set. A check is therefore
 * either the command to run — quoted by what it is, since the engines serve
 * repositories in several languages — or the review the role performs, stated
 * so the verifier knows no command is expected. */
const VERIFIER_CHECKS: Readonly<Record<string, readonly string[]>> = {
	"quality-verifier": [
		"Formatting, lint and type gates once, in one command, over the assigned files (in a Bun/TypeScript package: `bunx biome check <assigned files>`, then that package's type-check script). Do not run tests or a build unless they are the named gates.",
		"Any finding handed to you from an earlier round, rechecked against the current code: report only the ones that still reproduce.",
	],
	"security-verifier": [
		"Static review of the assigned files' trust boundaries: authentication and authorization, secret handling, injection, and validation of untrusted input. No command to run.",
	],
	"performance-verifier": [
		"Static review of the assigned files for work that grows without bound per request, per instance, or per item: unindexed scans, repeated process spawns, synchronous I/O on a hot path. No command to run.",
	],
	"openspec-verifier": [
		"Comparison of the assigned scope against the approved proposal, design, tasks and spec deltas, plus `openspec validate <change> --strict` once when the change is an OpenSpec change.",
	],
	"usability-verifier": [
		"Static review of the user-visible surface in the assigned files: error and empty-state text, failure handling a caller must live with, and naming that leaks into the API. No command to run.",
	],
	"test-quality-verifier": [
		"The focused tests that cover the assigned files, once, in one command. Never the complete suite (the engine-owned test-verifier runs it) and never a build.",
		"Tests that were skipped, disabled, or written so they cannot fail when their subject breaks.",
	],
	"concurrency-verifier": [
		"Static review of shared mutable state in the assigned files: unguarded read-modify-write, duplicate or late completion, retry and replay ordering, and idempotency. No command to run.",
	],
	"migration-verifier": [
		"Static review of persistence and upgrade paths in the assigned files: forward compatibility of existing state, defaults for rows or documents that predate the change, and no destructive rewrite without a guard. No command to run.",
	],
};

/** The checks an arriving verification or triage run is given. `core.triage`
 * scopes roles rather than reviewing code, so its single check states what the
 * plan must hold; an unknown verifier role still gets a usable line instead of
 * a dangling reference. */
function assignmentChecks(role: string): readonly string[] {
	if (role === "test-verifier")
		return [
			"The repository's complete configured test suite once, in a single command, then stop.",
		];
	if (role === "triage")
		return [
			"Every listed role has at least one file from the round's changed scope and no file outside it, and no role outside the locked selection is named. No command to run.",
		];
	return (
		VERIFIER_CHECKS[role] ?? [
			"The focused checks this role owns over the assigned files, run once. No further command is prescribed.",
		]
	);
}

/** Whether the OpenSpec verifier role is eligible, read from the family's
 * `openspecVerifier` trait instead of the definition id
 * (read-family-traits-instead-of-ids). A caller that passes no traits — a
 * classifier helper called with a bare id, or a tier below the family-traits
 * tier — falls back to the catalog table `effectiveFamilyTraits` reads, and a
 * definition that declares none (the documentation families) keeps today's
 * default of eligible. */
function openspecVerifierEligible(
	definitionId: string,
	traits?: WorkflowFamilyTraits,
): boolean {
	return (
		(traits ?? effectiveFamilyTraits({ id: definitionId }))?.openspecVerifier ??
		true
	);
}

/** The roles triage and the classifier may select for a definition: the
 * catalog minus the engine-owned full-suite role, minus the OpenSpec verifier
 * for a definition whose traits declare no OpenSpec surface. Single source for
 * the engine's selection validation, triage validation, and the per-round
 * classifier questions (`classifiers.ts`). */
export function triageRolesFor(
	definitionId: string,
	traits?: WorkflowFamilyTraits,
): string[] {
	return TRIAGE_ROLES.filter(
		(role) =>
			openspecVerifierEligible(definitionId, traits) ||
			role !== "openspec-verifier",
	);
}

function candidateRoles(
	definitionId: string,
	traits?: WorkflowFamilyTraits,
): string[] {
	return VERIFIER_ROLES.filter(
		(role) =>
			openspecVerifierEligible(definitionId, traits) ||
			role !== "openspec-verifier",
	);
}

/** The roles an arriving triage plan may name. An empty `selectedRoles` is the
 * unconstrained path (classifier fail-open, or a definition tier that predates
 * the routing step) and falls back to the full eligible catalog.
 *
 * With a real selection the intersection is a defensive narrowing only: the
 * classifier's own selection is produced from the same eligible set, so a role
 * outside the catalog can never arrive here. The engine's guarantee is that a
 * selection cannot introduce an ineligible role, and it cannot widen the plan
 * beyond `TRIAGE_ROLES` in either case. */
function allowedTriageRoles(
	definitionId: string,
	selectedRoles: readonly string[],
	traits?: WorkflowFamilyTraits,
): Set<string> {
	if (selectedRoles.length === 0)
		return new Set(triageRolesFor(definitionId, traits));
	const eligible = triageRolesFor(definitionId, traits);
	return new Set(selectedRoles.filter((role) => eligible.includes(role)));
}

function triageCompletion(ctx: {
	definitionId: string;
	outcome: string;
	output?: unknown;
	changedFiles?: readonly string[];
	snapshot: WorkflowSnapshot;
	traits?: WorkflowFamilyTraits;
}) {
	if (ctx.outcome !== "complete") return undefined;
	const output = ctx.output as {
		assignments: Array<{ role: string; files: string[] }>;
		roles: string[];
	};
	// The classifier may only narrow the round: a plan naming a role outside
	// the arrival selection is rejected like any other invalid selection.
	const allowed = allowedTriageRoles(
		ctx.definitionId,
		ctx.snapshot.step.selectedRoles,
		ctx.traits,
	);
	if (
		!Array.isArray(output.roles) ||
		output.roles.some((role) => typeof role !== "string") ||
		new Set(output.roles).size !== output.roles.length
	)
		throw new WorkflowRuntimeError("triage", "invalid verifier role selection");
	// A selection may be narrowed, never discarded: an empty plan would turn a
	// round the classifier gated up into a tests-only round. Only the routing
	// step's own `empty` outcome (which bypasses triage entirely) may select
	// nothing, and an unconstrained arrival still has no selection to keep.
	if (ctx.snapshot.step.selectedRoles.length && output.roles.length === 0)
		throw new WorkflowRuntimeError(
			"triage",
			"triage may narrow the selected roles but must keep at least one",
		);
	const assignmentRoles = new Set(output.assignments.map(({ role }) => role));
	if (
		output.roles.some(
			(role) => !allowed.has(role) || !assignmentRoles.has(role),
		) ||
		[...assignmentRoles].some((role) => !output.roles.includes(role))
	)
		throw new WorkflowRuntimeError("triage", "invalid verifier role selection");
	const changed = new Set(ctx.changedFiles ?? []);
	for (const assignment of output.assignments) {
		if (!allowed.has(assignment.role))
			throw new WorkflowRuntimeError(
				"triage",
				`unsupported verifier role: ${assignment.role}`,
			);
		for (const file of assignment.files)
			if (!changed.has(file))
				throw new WorkflowRuntimeError(
					"triage",
					`triage file is outside changed scope: ${file}`,
				);
	}
	return { step: { selectedRoles: output.roles } };
}

function verificationCompletion(
	ctx: Parameters<NonNullable<StepBehavior["onAgentComplete"]>>[0],
) {
	if (ctx.outcome !== "complete") return undefined;
	const result = {
		runId: ctx.run.id,
		role: ctx.run.role,
		critical: Number((ctx.output as { critical?: number })?.critical ?? 0),
		...(ctx.outputDigest ? { outputDigest: ctx.outputDigest } : {}),
	};
	const appendResults = [result];
	if (ctx.remainingActiveRunIds.length)
		return { deferTransition: true, step: { appendResults } };
	if (
		result.critical > 0 ||
		ctx.snapshot.step.results.some((item) => item.critical > 0)
	) {
		const limit = ctx.snapshot.loopCounts["core.verification:fix"] ?? 0;
		return {
			step: { appendResults },
			transition: {
				outcome:
					limit + 1 >= (ctx.loopMaxAttempts ?? Number.MAX_SAFE_INTEGER)
						? "limit"
						: "fix",
				output: {
					findings: ctx.evidence.filter((item) =>
						item.kind.startsWith("core.verification:"),
					),
				},
			},
		};
	}
	if (!ctx.snapshot.step.testRunStarted && ctx.run.role !== "test-verifier")
		return {
			deferTransition: true,
			step: { appendResults, testRunStarted: true },
			runs: [{ role: "test-verifier" }],
		};
	return {
		step: { appendResults },
		// The passing round hands its bounded results to the review gate, which
		// decides "does a developer need to see this?" with the verifier
		// evidence in hand.
		transition: {
			outcome: "pass",
			output: { verification: [...ctx.snapshot.step.results, result] },
		},
	};
}

/** The role set an arriving step adopts from its edge output, or — for a
 * self-loop retry with no fresh output — from the carried arrival context. */
function arrivingRoles(
	output: unknown,
	priorContext: unknown,
): { selectedRoles?: string[] } {
	const fromOutput = (value: unknown): string[] | undefined => {
		if (
			value &&
			typeof value === "object" &&
			"roles" in value &&
			Array.isArray((value as { roles: unknown }).roles)
		)
			return [...(value as { roles: string[] }).roles];
		return undefined;
	};
	const roles = fromOutput(output) ?? fromOutput(priorContext);
	return roles ? { selectedRoles: roles } : {};
}

export const verificationBehaviors: Readonly<Record<string, StepBehavior>> = {
	"core.triage": {
		classification: "single",
		roles: () => ["triage"],
		candidateRoles: () => ["triage"],
		assignmentInputs: ({ run }) => ({ checks: assignmentChecks(run.role) }),
		onAgentComplete: triageCompletion,
		// Attempt is seeded from the verification round counter so a triage
		// redo after a verification loop keeps the same round number. The
		// round's classifier selection arrives as the edge output; a self-loop
		// retry carries it forward through the arrival context instead.
		onArrive: ({ snapshot, output, prior }) => ({
			attempt: (snapshot.loopCounts["core.verification:round"] ?? 0) + 1,
			...arrivingRoles(output, prior.context),
		}),
		// The rendered step input is the round's locked role set.
		carriesOutputContext: true,
		roundScoped: true,
		// Triage owns its own constant group; verifiers group per role (pane.ts).
		paneGroup: "triage",
	},
	"core.verification": {
		classification: "single",
		assignmentInputs: ({ run }) => ({ checks: assignmentChecks(run.role) }),
		onAgentComplete: verificationCompletion,
		// Candidate roles configure routing before a run exists; active roles use
		// the selected subset during fan-out. An empty selection means the round
		// needs no domain verifier, so the engine-owned full suite is the only
		// role it runs.
		roles: ({ snapshot }) =>
			snapshot.step.selectedRoles.length
				? [...snapshot.step.selectedRoles]
				: ["test-verifier"],
		candidateRoles: ({ definitionId, traits }) =>
			candidateRoles(definitionId, traits),
		onArrive: ({ snapshot, output }) => {
			const round = (snapshot.loopCounts["core.verification:round"] ?? 0) + 1;
			snapshot.loopCounts["core.verification:round"] = round;
			const result: ArriveResult = { attempt: round };
			const roles = arrivingRoles(output, undefined).selectedRoles;
			if (roles) result.selectedRoles = roles;
			return result;
		},
		carriesOutputContext: true,
		// Round-scoped naming keeps each verifier's canonical identity stable
		// across rounds; groupByRole gives every verifier role its own tab.
		roundScoped: true,
		groupByRole: true,
		paneGroup: "verification",
	},
};
