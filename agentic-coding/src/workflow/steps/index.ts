import type { WorkflowSnapshot } from "../contracts.ts";
import { implementationBehavior } from "./implementation.ts";
import { lifecycleBehaviors } from "./lifecycle.ts";
import { planningBehaviors } from "./planning.ts";
import { researchBehavior } from "./research.ts";
import type { StepBehavior } from "./types.ts";
import { verificationBehaviors } from "./verification.ts";
import { wikiBehavior } from "./wiki.ts";

export const STEP_BEHAVIORS: Readonly<Record<string, StepBehavior>> =
	Object.freeze({
		...planningBehaviors,
		"core.implementation": implementationBehavior,
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

export function rolesForStep(id: string, snapshot: WorkflowSnapshot): string[] {
	return stepBehavior(id).roles?.({ snapshot }) ?? [];
}

export function assertStepBehaviorCoverage(stepIds: Iterable<string>): void {
	for (const id of new Set(stepIds)) stepBehavior(id);
}
