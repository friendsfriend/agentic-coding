// The developer wait (record-repairs-and-developer-waits, efficiency item 12).
//
// Three states already block a workflow in front of the developer: a pending
// developer question, a run handed over `blocked` (a login handoff, a peer
// handoff), and a step whose actor is the developer (an approval or a review
// gate). The wait is a *projection* of those states, derived on every read and
// never stored, so it cannot dangle: it ends exactly when the state that caused
// it changes.
//
// Pure and total: no store, no clock of its own, no throw. The read model
// publishes it as `view.waiting`; the engine derives the `workflow.waiting` /
// `workflow.waiting.ended` event pair from the same function, so a reader and
// the event log can never disagree about what a workflow is waiting for.
import type {
	ActorKind,
	DeveloperDialogueRecord,
	WorkflowRun,
	WorkflowSnapshot,
	WorkflowStatus,
	WorkflowWait,
} from "../../contracts/workflow.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../registry.ts";
import { ORCHESTRATOR_QUESTION_TARGET } from "./dialogue.ts";

/** What the projection reads. Each caller already has these rows: the view from
 * `viewFromRows`, the engine from the snapshot it just committed. */
export interface WaitState {
	readonly status: WorkflowStatus;
	readonly currentStep: string;
	/** When the current step was entered; absent in a legacy snapshot. */
	readonly stepEnteredAt?: string;
	/** The current step's actor, or absent when the pinned definition does not
	 * resolve it (a step the definition no longer carries). */
	readonly stepActor?: ActorKind;
	readonly questions: readonly DeveloperDialogueRecord[];
	readonly runs: readonly Pick<WorkflowRun, "id" | "status" | "completedAt">[];
}

/** The workflow's developer wait, or `undefined` when it is waiting for nobody.
 * No clock: every way a wait ends is a change to the state it is projected from.
 *
 * - A `completed` or `closed` workflow is not waiting for anyone: a wait still
 *   open at the close ends at the close.
 * - `question` wins over the other two: the developer owes an answer, whatever
 *   else the workflow has handed over. The oldest open question is the subject,
 *   so the wait — and its event pair — names the one the developer sees first.
 *   An ask routed to a peer agent is not the developer's wait; one still routed
 *   to the orchestrator is, because the developer is the backstop.
 * - `handoff` is a run the workflow handed over `blocked`; the run's own
 *   completion time is when the wait began.
 * - `approval` is a developer-actor step: the workflow sits there until the
 *   developer acts.
 *
 * The kind is deliberately derived from the state and not from a per-kind table:
 * a question kind the dialogue model grows later (a login handoff, a review
 * question) is covered without naming it here. */
export function workflowWait(state: WaitState): WorkflowWait | undefined {
	if (state.status === "completed" || state.status === "closed")
		return undefined;
	const question = oldestOpenQuestion(state.questions);
	if (question)
		return {
			kind: "question",
			subject: question.id,
			since: question.createdAt,
		};
	const blocked = state.runs.find((run) => run.status === "blocked");
	if (blocked)
		return {
			kind: "handoff",
			subject: blocked.id,
			...(blocked.completedAt ? { since: blocked.completedAt } : {}),
		};
	if (state.stepActor === "developer")
		return {
			kind: "approval",
			subject: state.currentStep,
			...(state.stepEnteredAt ? { since: state.stepEnteredAt } : {}),
		};
	return undefined;
}

/** Build the projection input from the state both callers hold. */
export function waitState(
	snapshot: Pick<
		WorkflowSnapshot,
		"status" | "currentStep" | "metadata" | "developerDialogue"
	>,
	runs: WaitState["runs"],
	stepActor: ActorKind | undefined,
): WaitState {
	return {
		status: snapshot.status,
		currentStep: snapshot.currentStep,
		stepEnteredAt: snapshot.metadata.stepEnteredAt,
		stepActor,
		questions: snapshot.developerDialogue ?? [],
		runs,
	};
}

/** Whether the store still holds a question the developer owes an answer for: a
 * record that is pending and not routed to a peer agent (one still routed to the
 * orchestrator counts, because the developer is the backstop).
 *
 * Deliberately not the modal's `developerPendingQuestion`: that one also asks
 * whether the record has passed its durable expiry, because an expired question
 * is no longer answerable. The wait ends when the *state* ends it — the record
 * leaving `pending`, which the expiry timer records — never by the clock alone.
 * A wait that the clock could end with no transition to record would leave the
 * start of the pair dangling, which is exactly what the pairing check looks for. */
function owedQuestion(
	item: Pick<DeveloperDialogueRecord, "status" | "targetRole">,
): boolean {
	return (
		(item.targetRole === undefined ||
			item.targetRole === ORCHESTRATOR_QUESTION_TARGET) &&
		item.status === "pending"
	);
}

/** The open question the developer has been waiting on longest. The dialogue
 * list is append-ordered anyway: the comparison makes the wait — and the event
 * pair that names it — independent of the order a caller passes in. */
function oldestOpenQuestion(
	questions: readonly DeveloperDialogueRecord[],
): DeveloperDialogueRecord | undefined {
	let oldest: DeveloperDialogueRecord | undefined;
	for (const item of questions) {
		if (!owedQuestion(item)) continue;
		if (
			oldest === undefined ||
			Date.parse(item.createdAt) < Date.parse(oldest.createdAt)
		)
			oldest = item;
	}
	return oldest;
}

/** The actor of one step of a pinned definition, or absent when the definition
 * does not carry the step (a pinned definition the registry no longer resolves
 * it from). Total on purpose: both the read model and the event derivation
 * project the wait from inside a path that must not throw. */
export function definitionStepActor(
	registry: Pick<WorkflowRegistry, "stepForDefinition">,
	definition: Pick<CompiledWorkflowDefinition, "id" | "steps" | "stepRefs">,
	stepId: string,
): ActorKind | undefined {
	if (!definition.steps.includes(stepId)) return undefined;
	return registry.stepForDefinition(definition, stepId).actor;
}
