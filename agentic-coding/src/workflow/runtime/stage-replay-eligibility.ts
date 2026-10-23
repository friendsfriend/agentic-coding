// Whether the plan a pinned `stage.plan-review` holds names a flow that could
// be replayed (`add-stage-flow-replay`). Runtime-layer so it may reach the
// stage-blocks registry/flow-registry and the filesystem directly; the pure
// `stage.plan-review` step behavior only consumes the boolean this computes
// (`workflow/runtime/store.ts`'s `actions()`).
//
// Only a run pinned to the historical plan tiers has a plan at all
// (`remove-stage-test-planner`): the current stage-test graph replays without
// one, so `stage_replay` does its own eligibility check instead of consulting
// this.
import type { WorkflowSnapshot } from "../../contracts/workflow.ts";
import {
	flowEligibility,
	readFlowEntry,
} from "../../stage-blocks/flow-registry.ts";
import { stageBlockRegistry } from "../../stage-blocks/registry.ts";
import type { JsonValue } from "../../stage-blocks/schema.ts";
import { stageTestPlan } from "../definitions/contracts.ts";

export function stageReplayEligible(snapshot: WorkflowSnapshot): boolean {
	try {
		const plan = stageTestPlan.parse(snapshot.metadata.stageTestPlan);
		if (plan.flowId === undefined || snapshot.metadata.worktree.trim() === "")
			return false;
		return flowEligibility({
			flowId: plan.flowId,
			root: snapshot.metadata.worktree,
			stage: snapshot.metadata.stage ?? "",
			inputs: (plan.inputs ?? {}) as Readonly<Record<string, JsonValue>>,
			registry: stageBlockRegistry,
			// The entry is read once here instead of being rediscovered inside
			// `flowEligibility` (`PERF-101`).
			entry: readFlowEntry(snapshot.metadata.worktree, plan.flowId).entry,
		}).eligible;
	} catch {
		return false;
	}
}
