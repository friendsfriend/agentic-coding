import { WorkflowRuntimeError } from "../contracts.ts";
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

function candidateRoles(definitionId: string): string[] {
	return VERIFIER_ROLES.filter(
		(role) => definitionId !== "no-openspec" || role !== "openspec-verifier",
	);
}

function triageCompletion(ctx: {
	definitionId: string;
	outcome: string;
	output?: unknown;
	changedFiles?: readonly string[];
}) {
	if (ctx.outcome !== "complete") return undefined;
	const output = ctx.output as {
		assignments: Array<{ role: string; files: string[] }>;
		roles: string[];
	};
	const allowed = new Set<string>(
		TRIAGE_ROLES.filter(
			(role) =>
				ctx.definitionId !== "no-openspec" || role !== "openspec-verifier",
		),
	);
	if (
		!Array.isArray(output.roles) ||
		output.roles.some((role) => typeof role !== "string") ||
		new Set(output.roles).size !== output.roles.length
	)
		throw new WorkflowRuntimeError("triage", "invalid verifier role selection");
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
	return { step: { appendResults }, transition: { outcome: "pass" } };
}

export const verificationBehaviors: Readonly<Record<string, StepBehavior>> = {
	"core.triage": {
		roles: () => ["triage"],
		candidateRoles: () => ["triage"],
		onAgentComplete: triageCompletion,
		// Attempt is seeded from the verification round counter so a triage
		// redo after a verification loop keeps the same round number.
		onArrive: ({ snapshot }) => ({
			attempt: (snapshot.loopCounts["core.verification:round"] ?? 0) + 1,
		}),
		roundScoped: true,
		// Triage owns its own tab; verifiers group separately (pane.ts).
		paneGroup: "triage",
	},
	"core.verification": {
		onAgentComplete: verificationCompletion,
		// Candidate roles configure routing before a run exists; active roles use
		// the selected subset (or the test/quality fallback) during fan-out.
		roles: ({ snapshot }) =>
			snapshot.step.selectedRoles.length
				? [...snapshot.step.selectedRoles]
				: snapshot.step.testRunStarted
					? ["test-verifier"]
					: ["quality-verifier"],
		candidateRoles: ({ definitionId }) => candidateRoles(definitionId),
		onArrive: ({ snapshot, output }) => {
			const round = (snapshot.loopCounts["core.verification:round"] ?? 0) + 1;
			snapshot.loopCounts["core.verification:round"] = round;
			const result: ArriveResult = { attempt: round };
			if (
				output &&
				typeof output === "object" &&
				"roles" in output &&
				Array.isArray((output as { roles: unknown }).roles)
			)
				result.selectedRoles = [...(output as { roles: string[] }).roles];
			return result;
		},
		carriesOutputContext: true,
		roundScoped: true,
		paneGroup: "verification",
	},
};
