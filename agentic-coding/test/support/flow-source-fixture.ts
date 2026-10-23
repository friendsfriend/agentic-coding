// A flow source built from a plan-shaped route, for tests of the generator and
// the eligibility decision.
//
// Production derives a flow from a standalone block plan
// (`flowSourceFromPlan`): a saved flow is data, and the tester's report states
// what it checked. A historical, plan-bound route still reaches the generator —
// flows a pinned stage-test run saved carry an expectation mapping — so the
// generator's own coverage needs a source that supplies that metadata.

import type {
	FlowExpectation,
	FlowSource,
} from "../../src/stage-blocks/flow.ts";
import { flowSourceFromPlan } from "../../src/stage-blocks/flow-source.ts";
import type { NormalizedStageBlockPlan } from "../../src/stage-blocks/plan.ts";

export interface RouteLikePlan {
	readonly flowId?: string;
	readonly expectations?: readonly {
		readonly id: string;
		readonly statement?: string;
		readonly priority?: string;
	}[];
	readonly route: readonly {
		readonly id: string;
		readonly application: string;
		readonly role?: string;
		readonly capture?: readonly string[];
		readonly expectationIds?: readonly string[];
		readonly block?: { readonly id: string; readonly version?: string };
	}[];
}

const PRIORITIES = new Set(["critical", "high", "medium", "low"]);

export function flowSourceFromRoute(options: {
	readonly routePlan: RouteLikePlan;
	readonly plan: NormalizedStageBlockPlan;
	readonly stage: string;
	readonly planId?: string;
	readonly revision?: number;
}): FlowSource {
	const base = flowSourceFromPlan({
		plan: options.plan,
		stage: options.stage,
		...(options.planId === undefined ? {} : { planId: options.planId }),
		...(options.revision === undefined ? {} : { revision: options.revision }),
	});
	const routeMeta = options.routePlan.route.map((entry) => ({
		id: entry.id,
		application: entry.application,
		...(entry.role === undefined ? {} : { role: entry.role }),
		expectationIds: [...(entry.expectationIds ?? [])],
		captures: [...(entry.capture ?? [])],
	}));
	const expectations: FlowExpectation[] = (
		options.routePlan.expectations ?? []
	).map((expectation) => ({
		id: expectation.id,
		statement: expectation.statement ?? expectation.id,
		priority: PRIORITIES.has(expectation.priority ?? "")
			? (expectation.priority as FlowExpectation["priority"])
			: "medium",
	}));
	return { ...base, routeMeta, expectations };
}
