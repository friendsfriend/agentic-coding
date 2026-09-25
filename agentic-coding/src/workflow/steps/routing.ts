// `core.route-plan` / `core.route-apply` behaviors
// (classifier-driven-model-pools). A system step that enqueues one
// `model.classify` routing effect on entry; the reducer applies the answered
// pool selections to the pinned routing before the effect-complete transition
// advances the step.
import { ROUTING_INTEGRATION } from "../classifiers.ts";
import type { StepBehavior } from "./types.ts";

export type RoutingPhase = "plan" | "apply";

function routingBehavior(phase: RoutingPhase): StepBehavior {
	return {
		onEnter: ({ snapshot, enqueue }) => {
			enqueue(
				"model.classify",
				`route:${snapshot.workflowId}:${snapshot.currentStep}:${snapshot.step.attempt}`,
				{ integration: ROUTING_INTEGRATION, phase },
			);
			return undefined;
		},
		onEffectComplete: ({ effect }) =>
			effect.kind === "model.classify"
				? { transition: { outcome: "complete", output: effect.data } }
				: undefined,
	};
}

export const routingBehaviors: Readonly<Record<string, StepBehavior>> =
	Object.freeze({
		"core.route-plan": routingBehavior("plan"),
		"core.route-apply": routingBehavior("apply"),
	});
