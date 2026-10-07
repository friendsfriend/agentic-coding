// The stage-gate step behaviors (add-jev-stage-gating). Each gate is a system
// step that enqueues exactly one `model.classify` effect on entry; the runner
// reads the stage's resolved policy from the pinned preset and answers
// `run`/`skip` (decided locally under `always`, asked of the classifier under
// `auto`). The behaviors own no gate vocabulary: the stage lives in the effect
// payload, and an unrecognized result degrades to `run` so a system step never
// parks the workflow with nothing running.
import { GATE_INTEGRATION, type GateStage } from "../classifiers.ts";
import type { ArriveResult, StepBehavior } from "./types.ts";

/** The stage gate in front of every gated stage (add-jev-stage-gating): the
 * newest tier enters each gated stage through its gate's `run` outcome, and the
 * custom-definition invariants check exactly this placement
 * (persist-custom-workflow-definitions). The archive is deliberately absent: it
 * is mandatory for completion, so no gate ever stands in front of it. */
export const GATE_GUARDED_STEP: Readonly<Record<string, string>> =
	Object.freeze({
		"core.plan-gate": "core.plan-approval",
		"core.review-gate": "core.developer-review",
		"core.wiki-gate": "core.wiki",
	});

/** One gate step: the shared `core.triage-route` shape, generalized from a
 * routing phase to a gate stage. */
function gateBehavior(stage: GateStage): StepBehavior {
	return {
		onEnter: ({ snapshot, enqueue }) => {
			enqueue(
				"model.classify",
				// The outbox keys are `INSERT OR IGNORE`, so a key that repeats
				// silently drops the effect and strands the step with no run and
				// nothing pending. The review gate is re-entered every
				// verification round with a constant attempt, so the key carries
				// the snapshot revision exactly as the triage key does.
				`gate:${snapshot.workflowId}:${stage}:${snapshot.currentStep}:${snapshot.revision}`,
				{ integration: GATE_INTEGRATION, stage },
			);
			return undefined;
		},
		onEffectComplete: ({ effect }) =>
			effect.kind === "model.classify"
				? gateCompletion(effect.data)
				: undefined,
	};
}

/** Always transitions: only an explicit `skip` routes around the guarded
 * stage, so an unrecognized, missing, or failed result runs it. */
function gateCompletion(data: unknown) {
	const decision = (data as { decision?: unknown } | undefined)?.decision;
	return {
		transition: { outcome: decision === "skip" ? "skip" : "run" },
	};
}

/** The bounded round summary the verification pass hands to the review gate. */
const verificationResults = (output: unknown): ArriveResult["results"] => {
	if (!output || typeof output !== "object") return undefined;
	const results = (output as { verification?: unknown }).verification;
	return Array.isArray(results)
		? (results as ArriveResult["results"])
		: undefined;
};

export const gateBehaviors: Readonly<Record<string, StepBehavior>> =
	Object.freeze({
		"core.plan-gate": gateBehavior("planApproval"),
		"core.review-gate": {
			...gateBehavior("developerReview"),
			// "Does a developer need to see this?" is asked with the round's
			// verifier results in hand, so they arrive as this step's own state
			// rather than as carried output context.
			onArrive: ({ output }) => {
				const results = verificationResults(output);
				return results ? { results } : undefined;
			},
		},
		"core.wiki-gate": gateBehavior("wiki"),
	});
