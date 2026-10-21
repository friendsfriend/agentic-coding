// Bridge the approved stage plan to the flow source (`add-stage-flow-replay`).
// The block plan owns normalized steps and resolved versions; the stage plan
// owns the route order, expectation mapping and captures.

import type { FlowExpectation, FlowRouteMeta, FlowSource } from "./flow.ts";
import type { NormalizedStageBlockPlan } from "./plan.ts";

export interface StagePlanLike {
	readonly flowId?: string;
	readonly ticketSummary?: string;
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
		readonly block?: {
			readonly id: string;
			readonly version?: string;
		};
	}[];
}

export class FlowSourceError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "FlowSourceError";
	}
}

const PRIORITIES = new Set(["critical", "high", "medium", "low"]);

export function flowSourceFromStagePlan(options: {
	readonly stagePlan: StagePlanLike;
	readonly plan: NormalizedStageBlockPlan;
	readonly stage: string;
	readonly planId: string;
	readonly revision?: number;
}): FlowSource {
	const flowId = options.stagePlan.flowId;
	if (flowId === undefined || flowId.trim() === "")
		throw new FlowSourceError(
			"flow-identity-missing",
			"the approved stage plan has no flowId; add one before saving a replay flow",
		);
	if (options.stagePlan.route.length !== options.plan.steps.length)
		throw new FlowSourceError(
			"flow-mixed-plan",
			"a replay flow needs exactly one block on every route step",
		);
	const routeMeta: FlowRouteMeta[] = options.stagePlan.route.map((entry) => {
		if (entry.block === undefined)
			throw new FlowSourceError(
				"flow-mixed-plan",
				`route step ${entry.id} has no block`,
			);
		return {
			id: entry.id,
			application: entry.application,
			...(entry.role === undefined ? {} : { role: entry.role }),
			expectationIds: [...(entry.expectationIds ?? [])],
			captures: [...(entry.capture ?? [])],
		};
	});
	for (const [index, step] of options.plan.steps.entries()) {
		const route = options.stagePlan.route[index];
		if (route === undefined || route.id !== step.id)
			throw new FlowSourceError(
				"flow-route-step-mismatch",
				`block step ${step.id} does not align with the approved route`,
			);
		const requested = route.block;
		if (requested === undefined || requested.id !== step.definition.id)
			throw new FlowSourceError(
				"flow-route-step-mismatch",
				`route step ${step.id} blocks with ${requested?.id ?? "nothing"}, but the plan normalized ${step.definition.id}`,
			);
		if (
			requested.version !== undefined &&
			requested.version !== step.definition.version
		)
			throw new FlowSourceError(
				"flow-block-version",
				`route step ${step.id} pins ${step.definition.id}@${requested.version}, but the registry resolved ${step.definition.version}`,
			);
	}
	const expectations: FlowExpectation[] = (
		options.stagePlan.expectations ?? []
	).map((expectation) => {
		const priority = PRIORITIES.has(expectation.priority ?? "")
			? (expectation.priority as FlowExpectation["priority"])
			: "medium";
		return {
			id: expectation.id,
			statement: expectation.statement ?? expectation.id,
			priority,
		};
	});
	return {
		flowId,
		...(options.stagePlan.ticketSummary === undefined
			? {}
			: { title: options.stagePlan.ticketSummary }),
		stage: options.stage,
		planId: options.planId,
		...(options.revision === undefined ? {} : { revision: options.revision }),
		inputs: options.plan.inputs,
		steps: options.plan.steps,
		routeMeta,
		expectations,
	};
}
