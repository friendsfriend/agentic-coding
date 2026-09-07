import type { WorkflowRouting } from "../contracts.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import { planResult } from "../definitions/contracts.ts";
import type { StepBehavior } from "./types.ts";
import {
	type PreparedStepEvidence,
	prepareStepEvidence,
	validatePlanningArtifacts,
} from "./validation.ts";

const validatePlanning = ({
	snapshot,
	evidence,
}: Parameters<NonNullable<StepBehavior["validateEvidence"]>>[0]) =>
	validatePlanningArtifacts(
		(evidence as PreparedStepEvidence | undefined) ??
			prepareStepEvidence(snapshot),
	);

const PLANNER_ROLE = /^planner-[1-5]$/;
const plannerRoles = (count: number): string[] =>
	Array.from({ length: count }, (_, index) => `planner-${index + 1}`);
const CHANGE_ID = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
function primaryChangeId(output: unknown): string {
	let primary: string;
	try {
		primary = planResult.parse(output).primaryChangeId;
	} catch (error) {
		throw new WorkflowRuntimeError(
			"entry-guard",
			`plan output must declare a primary change id: ${String((error as Error).message)}`,
		);
	}
	if (!CHANGE_ID.test(primary))
		throw new WorkflowRuntimeError("change-id", "change ID is invalid");
	return primary;
}
function validatePlanCompletion(ctx: {
	snapshot: {
		workflowId: string;
		currentStep: string;
		step: { attempt: number };
	};
	output?: unknown;
}) {
	const changeId = primaryChangeId(ctx.output);
	return {
		metadata: { changeId },
		deferTransition: true,
		effects: [
			{
				kind: "openspec.validate" as const,
				idempotencyKey: `openspec:${ctx.snapshot.workflowId}:${ctx.snapshot.currentStep === "core.plan" ? "plan" : "consolidate"}:${ctx.snapshot.step.attempt}`,
				payload: { changeId },
			},
		],
	};
}
function completeValidation(ctx: {
	effect: { kind: string };
}): { transition: { outcome: string } } | undefined {
	return ctx.effect.kind === "openspec.validate"
		? { transition: { outcome: "complete" } }
		: undefined;
}

export const fusionPlannerRoles = (routing: WorkflowRouting): string[] =>
	[
		...new Set(
			routing.routes
				.filter(
					(route) =>
						route.stepId === "fusion.plan" &&
						route.role !== undefined &&
						PLANNER_ROLE.test(route.role),
				)
				.map((route) => route.role as string),
		),
	].sort(
		(a, b) =>
			Number(a.slice("planner-".length)) - Number(b.slice("planner-".length)),
	);

export const planningBehaviors: Readonly<Record<string, StepBehavior>> = {
	"core.plan": {
		roles: () => ["planner"],
		candidateRoles: () => ["planner"],
		validateEvidence: validatePlanning,
		onAgentComplete: (ctx) =>
			ctx.outcome === "complete" ? validatePlanCompletion(ctx) : undefined,
		onEffectComplete: completeValidation,
		onArrive: ({ edge, outcome }) =>
			edge.to === "core.plan" && outcome === "comments"
				? { mode: "review-fix" }
				: undefined,
		carriesOutputContext: true,
	},
	"fusion.plan": {
		roles: ({ snapshot }) => fusionPlannerRoles(snapshot.routing),
		candidateRoles: ({ fusionPlannerCount }) =>
			plannerRoles(fusionPlannerCount),
		onAgentComplete: ({
			snapshot,
			run,
			outcome,
			outputDigest,
			remainingActiveRunIds,
			evidence,
		}) => {
			if (outcome !== "complete") return undefined;
			const results = [
				...snapshot.step.results,
				{
					runId: run.id,
					role: run.role,
					critical: 0,
					...(outputDigest ? { outputDigest } : {}),
				},
			];
			const expected = fusionPlannerRoles(snapshot.routing);
			if (
				remainingActiveRunIds.length === 0 &&
				expected.every((role) =>
					results.some((result) => result.role === role && result.outputDigest),
				)
			)
				return {
					step: {
						appendResults: [
							{
								runId: run.id,
								role: run.role,
								critical: 0,
								...(outputDigest ? { outputDigest } : {}),
							},
						],
					},
					transition: {
						outcome: "complete",
						output: {
							drafts: expected.map((role) => {
								const item = evidence.find(
									(entry) => entry.kind === `fusion.plan:${role}`,
								);
								return {
									role,
									path: item?.path ?? "",
									digest: item?.digest ?? "",
								};
							}),
						},
					},
				};
			return {
				deferTransition: true,
				step: {
					appendResults: [
						{
							runId: run.id,
							role: run.role,
							critical: 0,
							...(outputDigest ? { outputDigest } : {}),
						},
					],
				},
			};
		},
		onArrive: ({ edge, prior }) =>
			// Retry of a failed role resumes collection: surviving validated
			// drafts are preserved instead of re-fanning every planner.
			edge.from === "fusion.plan" && edge.to === "fusion.plan"
				? {
						results: prior.results.filter(
							(result) =>
								result.role.startsWith("planner-") && result.outputDigest,
						),
					}
				: undefined,
		onEnter: ({ snapshot, hasLiveRun }) => ({
			// Never relaunch a role whose validated draft already survived, nor
			// one whose run is still pending/working.
			skipRoles: fusionPlannerRoles(snapshot.routing).filter(hasLiveRun),
		}),
	},
	"fusion.consolidate": {
		roles: () => ["consolidator"],
		candidateRoles: () => ["consolidator"],
		validateEvidence: validatePlanning,
		onAgentComplete: (ctx) =>
			ctx.outcome === "complete" ? validatePlanCompletion(ctx) : undefined,
		onEffectComplete: completeValidation,
		carriesOutputContext: true,
	},
};
