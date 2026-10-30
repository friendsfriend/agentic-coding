import { createHash } from "node:crypto";
import type { WorkflowSnapshot } from "../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import { effectiveFamilyTraits } from "../definitions/manifest-policy.ts";
import type { ProtocolSectionId } from "../prompt-sections.ts";
import type { WorkflowFamilyTraits } from "../registry.ts";
import { ENGINE_OWNED_VERIFIER_ROLE, planRecord } from "./reverification.ts";
import type {
	ArriveResult,
	CompletionTelemetry,
	StepBehavior,
} from "./types.ts";

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

/** The round's file→role map as the telemetry it may carry: one count per role
 * plus a digest of the scoped `role:path` lines, never a path and never a file
 * body. The plan is as large as the change set, so the event stays bounded by
 * construction (counts + one 16-char digest) however many files it assigns. */
function fileMapTelemetry(
	prefix: string,
	plan: unknown,
): Record<string, unknown> {
	const assignments =
		plan && typeof plan === "object"
			? (plan as { assignments?: unknown }).assignments
			: undefined;
	const counts = new Map<string, number>();
	const lines: string[] = [];
	for (const entry of Array.isArray(assignments) ? assignments : []) {
		if (!entry || typeof entry !== "object") continue;
		const role =
			typeof (entry as { role?: unknown }).role === "string"
				? (entry as { role: string }).role
				: "unknown";
		const files = (entry as { files?: unknown }).files;
		for (const file of Array.isArray(files) ? files : [])
			if (typeof file === "string") {
				counts.set(role, (counts.get(role) ?? 0) + 1);
				lines.push(`${role}:${file}`);
			}
	}
	if (!lines.length) return {};
	lines.sort();
	return {
		[`${prefix}.files.by_role`]: [...counts]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([role, count]) => `${role}=${count}`)
			.join(","),
		[`${prefix}.files.digest`]: createHash("sha256")
			.update(lines.join("\n"))
			.digest("hex")
			.slice(0, 16),
		[`${prefix}.files.count`]: lines.length,
	};
}

function triageCompletion(ctx: {
	definitionId: string;
	outcome: string;
	output?: unknown;
	changedFiles?: readonly string[];
	snapshot: WorkflowSnapshot;
	traits?: WorkflowFamilyTraits;
	hasStep: (stepId: string) => boolean;
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
	const round = (ctx.snapshot.loopCounts["core.verification:round"] ?? 0) + 1;
	// The round's own decision, when the routing step recorded one for it: an
	// engine-scoped round attributes its role set to the scope rather than to the
	// classifier, even though the classifier still answered (role-scoped
	// re-verification).
	const decision = ctx.snapshot.verificationScope?.decision;
	const scoped = decision?.round === round && decision.mode === "scoped";
	const ownership = planRecord(output.assignments);
	return {
		step: { selectedRoles: output.roles },
		// The previous round's plan is what the next round scopes from, and the
		// transition that reaches it resets the step context this plan arrives in,
		// so the ownership is persisted here. A plan beyond the record's caps is
		// recorded as an empty plan — the field is always written, so it clears the
		// previous round's ownership instead of leaving it under this round's stamp
		// (the record is merged field by field). An empty plan widens the next round
		// rather than letting a truncated plan hide a file's owner.
		verificationScope: { round, plan: ownership.plan },
		// Which path produced the round's role set: the classifier's own
		// selection, the engine's re-verification scope, the unconstrained default
		// (a classifier outage inside a graph that asks), or the tier that
		// predates the routing step, where the triage agent always chose. The
		// zero-role bypasses never reach this step — they are recorded by the
		// routing step that decided them.
		telemetry: [
			{
				event: "triage.plan.selected",
				payload: {
					"herdr.triage.source": scoped
						? "reverification"
						: ctx.snapshot.step.selectedRoles.length
							? "classifier"
							: ctx.hasStep("core.triage-route")
								? "default"
								: "legacy-agent",
					// The round this plan is for: the counter `core.verification`'s own
					// arrival increments on entering the round it plans.
					"herdr.triage.round": round,
					"herdr.triage.roles": output.roles.join(","),
					"herdr.triage.roles.count": output.roles.length,
					...fileMapTelemetry("herdr.triage", output),
					...(ctx.changedFiles
						? { "herdr.triage.changed.count": ctx.changedFiles.length }
						: {}),
				},
			},
		],
	};
}

/** One verification round as the engine's bounded telemetry event
 * (`verification_round`): the round index, the runs and roles that took part,
 * the critical findings they handed over, the role selection the round was
 * locked to, and the plan's file→role counts and digest. A round that ended with
 * no critical finding reports `none`, so "this round found nothing" is a
 * measurement rather than an absence.
 *
 * The engine holds no per-finding id, no warning/info breakdown, and no turn,
 * token, or cost figure at this boundary — the handoff contract carries one
 * critical count per verifier run — so none of them is invented here. */
function verificationRoundTelemetry(
	ctx: Parameters<NonNullable<StepBehavior["onAgentComplete"]>>[0],
	result: { runId: string; role: string; critical: number },
): CompletionTelemetry {
	const results = [...ctx.snapshot.step.results, result];
	const roles: string[] = [];
	let critical = 0;
	for (const item of results) {
		if (!roles.includes(item.role)) roles.push(item.role);
		if (Number.isFinite(item.critical)) critical += item.critical;
	}
	return {
		event: "verification_round",
		payload: {
			"herdr.verification.round":
				ctx.snapshot.loopCounts["core.verification:round"] ?? 1,
			"herdr.verification.outcome": critical > 0 ? "findings" : "none",
			"herdr.verification.runs": results.map((item) => item.runId).join(","),
			"herdr.verification.runs.count": results.length,
			"herdr.verification.roles": roles.join(","),
			"herdr.verification.findings.critical": critical,
			...(ctx.snapshot.step.selectedRoles.length
				? {
						"herdr.verification.selected.roles":
							ctx.snapshot.step.selectedRoles.join(","),
					}
				: {}),
			...fileMapTelemetry("herdr.verification", ctx.snapshot.step.context),
			// No `changed.count` here: the engine resolves the change set at the
			// triage handoff, where the round's plan records it, and holds none at
			// this boundary. The round is still bounded by the counts and digest
			// above.
		},
	};
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
	// The round's own record, emitted only when the round really ends: a
	// deferred round (a sibling still running, the engine-owned suite not yet
	// dispatched) records nothing, so one round has exactly one event.
	const round = verificationRoundTelemetry(ctx, result);
	if (
		result.critical > 0 ||
		ctx.snapshot.step.results.some((item) => item.critical > 0)
	) {
		const limit = ctx.snapshot.loopCounts["core.verification:fix"] ?? 0;
		// The roles that reported the round's findings. The fix that follows exists
		// to resolve them, so the next round re-runs each of them whatever file the
		// fix touched — the floor that keeps a fixed finding from going unverified.
		// The engine-owned full-suite role is excluded: it runs anyway, and it is
		// not part of the catalog a scope may name.
		const reported = [
			...new Set(
				[...ctx.snapshot.step.results, result]
					.filter((item) => item.critical > 0)
					.map((item) => item.role)
					.filter((role) => role !== ENGINE_OWNED_VERIFIER_ROLE),
			),
		];
		return {
			step: { appendResults },
			telemetry: [round],
			verificationScope: {
				reported: {
					round: ctx.snapshot.loopCounts["core.verification:round"] ?? 0,
					roles: reported,
				},
			},
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
		telemetry: [round],
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

/** The optional protocol sections a verifier role receives: every verifier
 * reads file signals and may ask the classifier or delegate a check; the roles
 * that run or exercise the app also get the environment (and, for the usability
 * verifier, the browser; for test and performance, the debug tools). */
function verifierProtocolSections(role: string): readonly ProtocolSectionId[] {
	const review: ProtocolSectionId[] = [
		"delegated-debug",
		"file-signals",
		"jev",
	];
	if (role === "test-verifier" || role === "performance-verifier")
		return ["environment", "debug-tools", ...review];
	if (role === "usability-verifier")
		return ["environment", "browser", ...review];
	return review;
}

export const verificationBehaviors: Readonly<Record<string, StepBehavior>> = {
	"core.triage": {
		classification: "single",
		protocolSections: () => ["file-signals", "jev"],
		roles: () => ["triage"],
		candidateRoles: () => ["triage"],
		onEnter: ({ snapshot, traits }) => {
			// Older enterStep code overwrote the verifier selection with the
			// launched triage agent. Same-step recovery retains arrival context;
			// restore only that exact corruption, never widen a valid selection.
			if (
				snapshot.step.selectedRoles.length !== 1 ||
				snapshot.step.selectedRoles[0] !== "triage"
			)
				return;
			const roles = arrivingRoles(
				undefined,
				snapshot.step.context,
			).selectedRoles;
			const eligible = triageRolesFor(snapshot.definition.id, traits);
			if (
				!roles?.length ||
				new Set(roles).size !== roles.length ||
				roles.some((role) => !eligible.includes(role))
			)
				throw new WorkflowRuntimeError(
					"triage",
					"cannot restore verifier selection from retained arrival context",
				);
			snapshot.step.selectedRoles = [...roles];
		},
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
		protocolSections: ({ role }) => verifierProtocolSections(role),
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
