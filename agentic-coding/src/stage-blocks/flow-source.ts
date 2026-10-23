// Bridge a standalone block plan to the flow source
// (`remove-stage-test-planner`). The tester chooses its own route, so the flow
// source is derived from the plan's own steps: each step's route identity, the
// block's declared application and — when the block declares exactly one — its
// role. There is no plan projection to align with any more.

import type { FlowRouteMeta, FlowSource } from "./flow.ts";
import type { NormalizedStageBlockPlan } from "./plan.ts";

export class FlowSourceError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "FlowSourceError";
	}
}

export function flowSourceFromPlan(options: {
	readonly plan: NormalizedStageBlockPlan;
	readonly stage: string;
	readonly planId?: string;
	readonly title?: string;
	readonly revision?: number;
}): FlowSource {
	const flowId = options.plan.flowId;
	if (flowId === undefined || flowId.trim() === "")
		throw new FlowSourceError(
			"flow-identity-missing",
			"saving a flow needs a flowId on the block plan; add one before saving",
		);
	const routeMeta: FlowRouteMeta[] = options.plan.steps.map((step) => {
		const roles = step.definition.roles ?? [];
		return {
			id: step.id,
			application: step.definition.app,
			...(roles.length === 1 ? { role: roles[0] as string } : {}),
			expectationIds: [],
			captures: [],
		};
	});
	return {
		flowId,
		...(options.title === undefined ? {} : { title: options.title }),
		stage: options.stage,
		planId: options.planId ?? options.plan.planId,
		...(options.revision === undefined ? {} : { revision: options.revision }),
		inputs: options.plan.inputs,
		steps: options.plan.steps,
		routeMeta,
		// A saved flow carries its route, not a ticket expectation mapping: the
		// tester's report states what it checked (`remove-stage-test-planner`).
		expectations: [],
	};
}
