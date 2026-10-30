// An already committed canonical receipt is an idempotent read, not another
// mutation/event. Exact retries may use their original (now old) revision.
import {
	type ClarificationMutation,
	clarificationMutationSchema,
} from "../contracts/clarification.ts";
import { decodeContract } from "../contracts/decode.ts";
import type { WorkflowView } from "../contracts/workflow.ts";
import type { OrchestratorConversationIdentity } from "./auth.ts";
export function acceptedClarificationReplay(
	view: WorkflowView,
	actionId: string,
	raw: unknown,
	identity: OrchestratorConversationIdentity | undefined,
): boolean {
	if (
		!identity ||
		(actionId !== "clarification.grounded" &&
			actionId !== "clarification.confirm")
	)
		return false;
	const input = decodeContract<ClarificationMutation>(
		"server.clarification.replay",
		clarificationMutationSchema,
		raw,
	);
	const attachment = view.clarificationAttachment;
	if (
		!attachment ||
		attachment.hostId !== identity.hostId ||
		attachment.conversationId !== identity.conversationId ||
		attachment.epoch !== input.epoch
	)
		return false;
	const question = view.developerDialogue?.find(
		(item) => item.id === input.questionId,
	);
	const state = question?.clarification;
	const resolution = state?.resolution;
	if (
		!question ||
		question.runId !== input.askingRunId ||
		!state ||
		state.attachment.hostId !== identity.hostId ||
		state.attachment.conversationId !== identity.conversationId ||
		state.attachment.epoch !== input.epoch ||
		!resolution ||
		resolution.receipt !== input.receipt ||
		question.status !== "answered"
	)
		return false;
	const questions = (
		question.groupId
			? (view.developerDialogue ?? []).filter(
					(item) => item.groupId === question.groupId,
				)
			: [question]
	).sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0));
	if (
		questions.some(
			(item) =>
				item.status !== "answered" ||
				item.clarification?.resolution?.receipt !== input.receipt,
		)
	)
		return false;
	if (actionId === "clarification.confirm")
		return (
			input.responses === undefined &&
			resolution.origin === "confirmed-developer" &&
			resolution.candidateVersion === input.version &&
			resolution.confirmation.messageId === input.confirmationMessageId
		);
	return (
		resolution.origin === "grounded-orchestrator" &&
		resolution.rationale === input.rationale &&
		JSON.stringify(resolution.sources) === JSON.stringify(input.sources) &&
		JSON.stringify(
			questions.map((item) => ({
				questionId: item.id,
				kind: item.answer?.kind,
				value: item.answer?.value,
			})),
		) === JSON.stringify(input.responses)
	);
}
