// Pure clarification protocol guards. Authentication and transcript lookup must
// happen at the host/server boundary; these functions do not mint authority.
import type {
	ClarificationAttachment,
	ClarificationResponse,
	ClarificationState,
	DeveloperDialogueRecord,
} from "../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../contracts.ts";

function reject(message: string): never {
	throw new WorkflowRuntimeError("stale-question", message);
}

export function assertClarificationCustody(
	attached: ClarificationAttachment | undefined,
	caller: ClarificationAttachment,
): void {
	if (
		!attached ||
		attached.hostId !== caller.hostId ||
		attached.conversationId !== caller.conversationId ||
		attached.epoch !== caller.epoch
	)
		reject("clarification conversation or attachment epoch changed");
}

/** Validate an entire ordered questionnaire, never a partial conversational
 * reply. Values remain exact (including multiline custom answers). */
export function assertClarificationResponses(
	questions: readonly DeveloperDialogueRecord[],
	responses: readonly ClarificationResponse[],
): void {
	if (!questions.length || questions.length !== responses.length)
		reject("clarification requires the complete response set");
	const ordered = [...questions].sort(
		(a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0),
	);
	const first = ordered[0];
	if (!first) reject("clarification has no question");
	if (!first.groupId && ordered.length !== 1)
		reject("independent clarifications cannot share a response set");
	const ids = new Set<string>();
	for (const [index, question] of ordered.entries()) {
		const response = responses[index];
		if (
			!response ||
			ids.has(question.id) ||
			question.workflowId !== first.workflowId ||
			question.runId !== first.runId ||
			question.stepId !== first.stepId ||
			question.groupId !== first.groupId ||
			(first.groupId !== undefined && question.itemIndex !== index) ||
			question.status !== "pending" ||
			question.kind === "login-handoff" ||
			(question.targetRole !== undefined &&
				question.targetRole !== "orchestrator") ||
			response.questionId !== question.id
		)
			reject("clarification response set is stale or mismatched");
		ids.add(question.id);
		if (
			response.kind === "option" &&
			!question.options.some((option) => option.value === response.value)
		)
			reject("clarification option is not offered by this question");
	}
}

/** Only host-verified transcript metadata reaches this guard. A model's
 * supplied role/message body is not a trusted transcript record. Semantic
 * assent remains an intentional orchestrator decision, not a regex listener. */
export interface TrustedClarificationMessage {
	hostId: string;
	conversationId: string;
	messageId: string;
	sequence: number;
	role: "assistant" | "developer" | "system" | "tool";
}

export function assertClarificationConfirmation(
	state: ClarificationState,
	version: number,
	proposal: TrustedClarificationMessage,
	confirmation: TrustedClarificationMessage,
): void {
	const candidate = state.candidate;
	if (!candidate || candidate.version !== version || state.resolution)
		reject("clarification proposal is stale or already resolved");
	for (const message of [proposal, confirmation]) {
		if (
			message.hostId !== state.attachment.hostId ||
			message.conversationId !== state.attachment.conversationId
		)
			reject("clarification transcript belongs to another conversation");
	}
	if (
		proposal.role !== "assistant" ||
		proposal.messageId !== candidate.proposal.messageId ||
		proposal.sequence !== candidate.proposal.sequence ||
		confirmation.role !== "developer" ||
		confirmation.sequence <= proposal.sequence ||
		confirmation.messageId === proposal.messageId
	)
		reject("clarification requires a subsequent real developer confirmation");
}
