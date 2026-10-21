// Whether the approved `stage.plan-review` plan names a flow eligible for
// replay (`add-stage-flow-replay`). Runtime-layer so it may reach the
// stage-blocks registry/flow-registry and the filesystem directly; the pure
// `stage.plan-review` step behavior only consumes the boolean this computes
// (`workflow/runtime/store.ts`'s `actions()`).
import type { WorkflowSnapshot } from "../../contracts/workflow.ts";
import {
	flowEligibility,
	readFlowRegistry,
} from "../../stage-blocks/flow-registry.ts";
import { flowSourceFromStagePlan } from "../../stage-blocks/flow-source.ts";
import {
	blockPlanFromRoute,
	validateStageBlockPlan,
} from "../../stage-blocks/plan.ts";
import { stageBlockRegistry } from "../../stage-blocks/registry.ts";
import type { JsonValue } from "../../stage-blocks/schema.ts";
import { stageTestPlan } from "../definitions/contracts.ts";

export function stageReplayEligible(snapshot: WorkflowSnapshot): boolean {
	try {
		const plan = stageTestPlan.parse(snapshot.metadata.stageTestPlan);
		if (plan.flowId === undefined || snapshot.metadata.worktree.trim() === "")
			return false;
		const projected = blockPlanFromRoute(
			plan.route as unknown as Parameters<typeof blockPlanFromRoute>[0],
			{
				planId: `stage-${snapshot.workflowId}`,
				flowId: plan.flowId,
				inputs: (plan.inputs ?? {}) as Readonly<Record<string, JsonValue>>,
			},
		);
		if (projected.missing.length > 0) return false;
		const validated = validateStageBlockPlan(projected.plan, {
			registry: stageBlockRegistry,
			policy: {
				stage: snapshot.metadata.stage ?? "",
				access:
					snapshot.metadata.stageAccess === "writable"
						? "writable"
						: "read-only",
				writeAllowed:
					snapshot.metadata.stageAccess === "writable" &&
					plan.createsData === true,
				// Every declared application is accepted here, with no role
				// restriction (`policy.role` unset skips the role check below): the
				// plan's own route already pinned an application/role per step, and
				// the full stage-catalog app/role check runs again at the actual
				// `stage_replay` call, which refuses an ineligible combination the
				// same way a non-replayed execute run would.
				apps: Object.fromEntries(
					[...new Set(plan.route.map((step) => step.application))].map(
						(app) => [app, {}],
					),
				),
			},
		});
		if (validated.plan === undefined) return false;
		return flowEligibility({
			flowId: plan.flowId,
			root: snapshot.metadata.worktree,
			stage: snapshot.metadata.stage ?? "",
			source: flowSourceFromStagePlan({
				stagePlan: plan,
				plan: validated.plan,
				stage: snapshot.metadata.stage ?? "",
				planId: `stage-${snapshot.workflowId}`,
			}),
			registry: stageBlockRegistry,
		}).eligible;
	} catch {
		return false;
	}
}

export { readFlowRegistry };
