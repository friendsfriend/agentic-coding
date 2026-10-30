import {
	decodeDeveloperQuestionAnswer,
	type WorkflowCommand,
} from "../../src/contracts/workflow.ts";
import { clarificationDigest } from "../../src/workflow/runtime/clarification-actions.ts";
import type { WorkflowEngine } from "../../src/workflow/runtime.ts";

export const engineTestAttachment = {
	hostId: "fixture-home",
	conversationId: "fixture-conversation",
	epoch: 1,
};

/** Unit-level server-authority adapter for existing dialogue/continuation tests.
 * These tests exercise atomic persistence, not semantic model judgment. Real
 * native custody/input proofs and explicit confirmation are tested separately
 * through the fake-provider host and authenticated HTTP server. */
export function clarificationEngineAction(
	engine: WorkflowEngine,
	repo: string,
	command: WorkflowCommand,
) {
	if (
		command.type !== "developer.action" ||
		command.actionId !== "answer-question"
	)
		return engine.dispatch(repo, command);
	const answer = decodeDeveloperQuestionAnswer(command.input);
	const snapshot = engine.getSnapshot(repo, command.workflowId);
	const question = snapshot.developerDialogue.find((item) =>
		"questionId" in answer
			? item.id === answer.questionId
			: item.groupId === answer.groupId,
	);
	if (!question?.clarification)
		throw new Error("fixture must explicitly attach before asking");
	const responses =
		"responses" in answer
			? answer.responses
			: answer.kind === "cancel"
				? undefined
				: [
						{
							questionId: question.id,
							kind: answer.kind,
							value: answer.value ?? "",
						},
					];
	const source = {
		kind: "task" as const,
		id: "task",
		digest: clarificationDigest(snapshot.metadata.task ?? ""),
	};
	return engine.dispatch(repo, {
		...command,
		actionId:
			"kind" in answer && answer.kind === "cancel"
				? "clarification.cancel"
				: "clarification.grounded",
		principal: "orchestrator",
		input: {
			questionId: question.id,
			askingRunId: question.runId,
			homeRunId: "fixture-home-run",
			epoch: question.clarification.attachment.epoch,
			...(responses ? { responses } : {}),
			rationale: "Unit fixture supplies the server-certified task agreement.",
			sources: [source],
			receipt: `unit:${question.id}`,
		},
		clarificationAuthority: {
			attachment: question.clarification.attachment,
			messages: [],
			sources: [source],
		},
	});
}
