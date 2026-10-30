import type { WorkflowView } from "../contracts/workflow.ts";
import type {
	ClarificationDeliveryRequest,
	ClarificationDeliveryResponse,
} from "./protocol.ts";

/** A pure, addressed delivery plan. Discovery never grants custody, and neither
 * startedBy nor the currently visible Home is a destination. The note contains
 * references, not untrusted question text or an answer instruction. */
export function clarificationDeliveries(
	view: WorkflowView,
): Omit<ClarificationDeliveryRequest, "type">[] {
	const attachment = view.clarificationAttachment;
	if (!attachment || view.status === "completed" || view.status === "closed")
		return [];
	const seen = new Set<string>();
	return (view.developerDialogue ?? []).flatMap((question) => {
		const state = question.clarification;
		if (
			question.kind === "login-handoff" ||
			question.status !== "pending" ||
			!state ||
			state.delivery.status !== "pending" ||
			state.attachment.hostId !== attachment.hostId ||
			state.attachment.conversationId !== attachment.conversationId ||
			state.attachment.epoch !== attachment.epoch ||
			seen.has(state.delivery.id)
		)
			return [];
		seen.add(state.delivery.id);
		return [
			{
				hostId: attachment.hostId,
				conversationId: attachment.conversationId,
				deliveryId: state.delivery.id,
				text: `Workflow clarification pending. This internal notification is not a developer message or an authorization to answer. Read workflow_status and workflow_action clarification.context for the following exact workflow/question, then follow that context's discussion/grounding/confirmation protocol. Do not select another conversation, use legacy answer-question, or treat unrelated chat as assent.\n${JSON.stringify({ repo: view.repository, workflowId: view.workflowId, questionId: question.id, askingRunId: question.runId, epoch: attachment.epoch, deliveryId: state.delivery.id })}`,
			},
		];
	});
}

/** Boundary adapter: accepted native input and durable workflow receipt are
 * separate commits. Retrying after either crash uses the same native request
 * identity. Never mark accepted on a transport error or a mismatched receipt. */
export async function deliverClarifications(
	view: WorkflowView,
	deliver: (
		request: Omit<ClarificationDeliveryRequest, "type">,
	) => Promise<ClarificationDeliveryResponse>,
	acknowledge: (
		receipt: ClarificationDeliveryResponse,
		questionId: string,
		askingRunId: string,
	) => Promise<void>,
): Promise<void> {
	for (const request of clarificationDeliveries(view)) {
		const receipt = await deliver(request);
		if (
			receipt.type !== "clarificationDelivery" ||
			receipt.hostId !== request.hostId ||
			receipt.conversationId !== request.conversationId ||
			receipt.deliveryId !== request.deliveryId ||
			!receipt.runId
		)
			throw new Error("clarification delivery acknowledgement mismatch");
		const question = view.developerDialogue?.find(
			(item) => item.clarification?.delivery.id === request.deliveryId,
		);
		if (question) await acknowledge(receipt, question.id, question.runId);
	}
}
