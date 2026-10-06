// Pure transition detector for the workflow monitor (add-orchestrator-workflow-
// monitoring, task 1.1). No I/O, no timers, no gateway: a workflow view is
// projected to the small state the monitor cares about, and two successive
// projections of the same workflow are diffed into typed transitions.
//
// The first observation of a workflow only records its projection: a workflow
// that already waits at plan approval when the shell starts is the developer's
// situation, not news. Every later edge (a review step entered, a developer
// question acquired, the workflow becoming `attention-required`, a newly failed
// effect, completion) is one transition — and an obligation that clears and
// returns produces a new one, because the detector compares the two projections
// and keeps no history of its own.
import type {
	EffectKind,
	WorkflowStatus,
	WorkflowView,
} from "../../contracts/workflow.ts";
import { HUMAN_REVIEW_STEPS } from "../../server/orchestrator-policy.ts";

/** What a workflow looks like to the monitor. Deliberately small and fully
 * enumerable, so a transition is a decision about two of these and nothing
 * else. */
export interface WorkflowProjection {
	readonly status: WorkflowStatus;
	readonly stepId: string;
	readonly stepLabel: string;
	/** The current step is one whose decision belongs to the developer. */
	readonly reviewPending: boolean;
	/** At least one developer question is waiting for an answer. */
	readonly questionPending: boolean;
	/** Effects currently in `failed`, with the kind that names them. */
	readonly failedEffects: readonly { id: string; kind: EffectKind }[];
	readonly completed: boolean;
}

export type TransitionKind =
	| "review-pending"
	| "question-pending"
	| "attention-required"
	| "effect-failed"
	| "completed";

/** One detected edge. `effects` is present on `effect-failed` only. */
export interface WorkflowTransition {
	readonly workflowId: string;
	readonly kind: TransitionKind;
	readonly stepId: string;
	readonly stepLabel: string;
	readonly effects?: readonly { id: string; kind: EffectKind }[];
}

/** The kinds that owe the developer a decision, so the shell raises a
 * notification for them whatever the monitor mode (except `off`). */
export function isHumanNeeded(kind: TransitionKind): boolean {
	return kind === "review-pending" || kind === "question-pending";
}

/** Project one workflow view. Pure: every field is read from the view, so two
 * views with the same relevant state project identically. */
export function projectWorkflow(view: WorkflowView): WorkflowProjection {
	const stepId = view.currentStep?.id ?? "";
	const failedEffects = (view.effects ?? [])
		.filter((effect) => effect.status === "failed")
		.map((effect) => ({ id: effect.id, kind: effect.kind }));
	return {
		status: view.status,
		stepId,
		stepLabel: view.currentStep?.label ?? stepId,
		reviewPending: HUMAN_REVIEW_STEPS.has(stepId),
		questionPending: (view.pendingQuestions?.length ?? 0) > 0,
		failedEffects,
		completed: view.status === "completed",
	};
}

/** The transitions from `previous` to `next`, in a stable order. An absent
 * `previous` is a first observation: the baseline is recorded, never reported. */
export function detectTransitions(
	previous: WorkflowProjection | undefined,
	next: WorkflowProjection,
	workflowId: string,
): WorkflowTransition[] {
	if (!previous) return [];
	const transitions: WorkflowTransition[] = [];
	const step = { stepId: next.stepId, stepLabel: next.stepLabel };
	if (!previous.reviewPending && next.reviewPending)
		transitions.push({ workflowId, kind: "review-pending", ...step });
	if (!previous.questionPending && next.questionPending)
		transitions.push({ workflowId, kind: "question-pending", ...step });
	if (
		previous.status !== "attention-required" &&
		next.status === "attention-required"
	)
		transitions.push({ workflowId, kind: "attention-required", ...step });
	const previouslyFailed = new Set(
		previous.failedEffects.map((effect) => effect.id),
	);
	const newlyFailed = next.failedEffects.filter(
		(effect) => !previouslyFailed.has(effect.id),
	);
	if (newlyFailed.length > 0)
		transitions.push({
			workflowId,
			kind: "effect-failed",
			...step,
			effects: newlyFailed,
		});
	if (!previous.completed && next.completed)
		transitions.push({ workflowId, kind: "completed", ...step });
	return transitions;
}

/** One line of a monitor note: what changed, on which target step. */
export function describeTransition(transition: WorkflowTransition): string {
	switch (transition.kind) {
		case "review-pending":
			return "developer review waiting";
		case "question-pending":
			return "developer question pending";
		case "attention-required":
			return "attention required";
		case "effect-failed":
			return `effect failed: ${(transition.effects ?? [])
				.map((effect) => effect.kind)
				.join(", ")}`;
		case "completed":
			return "completed";
	}
}

/** One coalesced note: the fixed prefix followed by one line per transition,
 * each naming the workflow, the step it reached and what changed. */
export function formatMonitorNote(
	transitions: readonly WorkflowTransition[],
): string {
	return [
		"[workflow-monitor]",
		...transitions.map(
			(transition) =>
				`- ${transition.workflowId} → ${transition.stepId} (${describeTransition(transition)})`,
		),
	].join("\n");
}
