// `core.model-selection` behavior (introduce-jev-for-model-range-decision).
//
// A system step: on entry it enqueues one `model.classify` effect for the
// classification integration, and when that effect completes it advances.
// The engine's effect-result reducer rewrites `core.implementation`'s pinned
// route from the answered category before the transition, so the worker is
// spawned with the selected profile.
import { complexityClassifier } from "../classifiers.ts";
import type { StepBehavior } from "./types.ts";

export const modelSelectionBehavior: StepBehavior = {
	onEnter: ({ snapshot, enqueue }) => {
		enqueue(
			"model.classify",
			`classify:${snapshot.workflowId}:${snapshot.step.attempt}:${complexityClassifier.id}`,
			{ integration: complexityClassifier.id },
		);
		return undefined;
	},
	onEffectComplete: ({ effect }) =>
		effect.kind === "model.classify"
			? { transition: { outcome: "complete", output: effect.data } }
			: undefined,
};
