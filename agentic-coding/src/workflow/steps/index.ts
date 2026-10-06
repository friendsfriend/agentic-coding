import type { WorkflowSnapshot } from "../../contracts/workflow.ts";
import { gateBehaviors } from "./gates.ts";
import { implementationBehavior } from "./implementation.ts";
import { lifecycleBehaviors } from "./lifecycle.ts";
import { planningBehaviors } from "./planning.ts";
import { rebaseBehavior } from "./rebase.ts";
import { researchBehavior } from "./research.ts";
import { routingBehaviors } from "./routing.ts";
import type { StepBehavior } from "./types.ts";
import { verificationBehaviors } from "./verification.ts";
import { wikiBehavior } from "./wiki.ts";

export const STEP_BEHAVIORS: Readonly<Record<string, StepBehavior>> =
	Object.freeze({
		...planningBehaviors,
		...routingBehaviors,
		...gateBehaviors,
		"core.implementation": implementationBehavior,
		"core.rebase": rebaseBehavior,
		...verificationBehaviors,
		"core.wiki": wikiBehavior,
		"core.research": researchBehavior,
		...lifecycleBehaviors,
	});

export function stepBehavior(id: string): StepBehavior {
	const behavior = STEP_BEHAVIORS[id];
	if (!behavior) throw new Error(`missing step behavior: ${id}`);
	return behavior;
}

/** Every classifiable step and its selection mode, derived from the registered
 * behaviors so a step's `classification` declaration is the only place that
 * knows it (classifier-driven-step-model-selection). Config parsing, pool
 * coverage validation, and the routing pass all read this one table. */
export const CLASSIFIABLE_STEPS: Readonly<Record<string, "single" | "roster">> =
	Object.freeze(
		Object.fromEntries(
			Object.entries(STEP_BEHAVIORS)
				.filter(([, behavior]) => behavior.classification !== undefined)
				.map(([id, behavior]) => [id, behavior.classification]) as Array<
				[string, "single" | "roster"]
			>,
		),
	);

export function rolesForStep(id: string, snapshot: WorkflowSnapshot): string[] {
	return stepBehavior(id).roles?.({ snapshot }) ?? [];
}

export function assertStepBehaviorCoverage(stepIds: Iterable<string>): void {
	for (const id of new Set(stepIds)) stepBehavior(id);
}
