// Deterministic canonical clarification mutations. Authentication, native
// transcript resolution and source reads belong to the server boundary.
import { createHash } from "node:crypto";
import {
	type ClarificationMutation,
	clarificationAttachSchema,
	clarificationMutationSchema,
} from "../../contracts/clarification.ts";
import { decodeContract } from "../../contracts/decode.ts";
import type {
	ClarificationAuthority,
	ClarificationResponse,
	ClarificationState,
	DeveloperDialogueRecord,
	WorkflowCommand,
	WorkflowSnapshot,
} from "../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import {
	assertClarificationConfirmation,
	assertClarificationCustody,
	assertClarificationResponses,
} from "./clarification.ts";
import { assertDialogueContentBound } from "./dialogue.ts";

type Action = Extract<WorkflowCommand, { type: "developer.action" }>;
function reject(message: string): never {
	throw new WorkflowRuntimeError("stale-question", message);
}
export function clarificationDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function clarificationDeliveryId(
	workflowId: string,
	id: string,
	epoch: number,
): string {
	return `clarification:${clarificationDigest([workflowId, id, epoch])}`;
}
export function renderClarificationProposal(
	questions: readonly DeveloperDialogueRecord[],
	responses: readonly ClarificationResponse[],
	version: number,
): string {
	return [
		`Proposed clarification answer for ${questions[0]?.workflowId ?? "unknown"} / ${questions[0]?.groupId ?? questions[0]?.id ?? "unknown"} (version ${version}):`,
		...responses.map(
			(response, index) =>
				`${index + 1}. ${questions.find((item) => item.id === response.questionId)?.description ?? ""}\n${response.value}`,
		),
		"Please confirm this exact proposed answer before I relay it to the workflow.",
	].join("\n\n");
}
function ordinary(question: DeveloperDialogueRecord): boolean {
	return (
		question.kind !== "login-handoff" &&
		(question.targetRole === undefined ||
			question.targetRole === "orchestrator")
	);
}
function authorityFor(command: Action): ClarificationAuthority {
	const authority = command.clarificationAuthority;
	if (!authority) reject("authenticated clarification context is required");
	return authority;
}
export function clarificationQuestions(
	snapshot: WorkflowSnapshot,
	input: Pick<ClarificationMutation, "questionId" | "askingRunId">,
	historical = false,
): DeveloperDialogueRecord[] {
	const question = snapshot.developerDialogue.find(
		(item) => item.id === input.questionId,
	);
	if (
		!question ||
		!ordinary(question) ||
		question.runId !== input.askingRunId ||
		(!historical &&
			(question.stepId !== snapshot.currentStep ||
				(!snapshot.step.activeRunIds.includes(question.runId) &&
					!snapshot.step.completedRunIds.includes(question.runId))))
	)
		reject("clarification asker is stale or mismatched");
	return (
		question.groupId
			? snapshot.developerDialogue.filter(
					(item) => item.groupId === question.groupId,
				)
			: [question]
	).sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0));
}
export function mutateClarification(
	snapshot: WorkflowSnapshot,
	command: Action,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	if (
		command.actionId !== "clarification.ack" &&
		(snapshot.status === "closed" || snapshot.status === "completed")
	)
		reject("terminal workflows do not accept clarifications");
	const authority = authorityFor(command);
	if (command.actionId === "clarification.attach") {
		if (command.principal === "orchestrator")
			reject("only the developer may attach clarification custody");
		const input = decodeContract<
			import("../../contracts/clarification.ts").ClarificationAttach
		>("clarification.attach", clarificationAttachSchema, command.input);
		if (
			input.hostId !== authority.attachment.hostId ||
			input.conversationId !== authority.attachment.conversationId
		)
			reject("attachment must name the verified Home conversation");
		const previousAttachment = snapshot.metadata.clarificationAttachment;
		const attachment = {
			hostId: input.hostId,
			conversationId: input.conversationId,
			epoch: (snapshot.metadata.clarificationAttachment?.epoch ?? 0) + 1,
		};
		snapshot.metadata.clarificationAttachment = attachment;
		for (const question of snapshot.developerDialogue) {
			if (!ordinary(question) || question.status !== "pending") continue;
			question.targetRole = "orchestrator";
			question.clarification = {
				...(question.clarificationAwaitingHandoff
					? { awaitingHandoff: true }
					: {}),
				attachment: { ...attachment },
				delivery: {
					id: clarificationDeliveryId(
						snapshot.workflowId,
						question.groupId ?? question.id,
						attachment.epoch,
					),
					status: "pending",
				},
			};
		}
		assertDialogueContentBound(snapshot.developerDialogue);
		return {
			type: "clarification.attached",
			actor: { kind: "developer" },
			data: {
				attachment,
				...(previousAttachment ? { previousAttachment } : {}),
			},
		};
	}
	if (command.principal !== "orchestrator")
		reject(
			"clarification mutation requires its authenticated Home conversation",
		);
	const input = decodeContract<ClarificationMutation>(
		"clarification.mutation",
		clarificationMutationSchema,
		command.input,
	);
	assertClarificationCustody(snapshot.metadata.clarificationAttachment, {
		...authority.attachment,
		epoch: input.epoch,
	});
	assertClarificationCustody(
		snapshot.metadata.clarificationAttachment,
		authority.attachment,
	);
	const questions = clarificationQuestions(
		snapshot,
		input,
		command.actionId === "clarification.ack",
	);
	const first = questions[0];
	if (
		!first?.clarification ||
		questions.some(
			(question) =>
				(command.actionId !== "clarification.ack" &&
					question.status !== "pending") ||
				!question.clarification,
		)
	)
		reject("clarification is no longer pending or attached");
	for (const question of questions)
		assertClarificationCustody(
			question.clarification?.attachment,
			authority.attachment,
		);
	const state = first.clarification;
	const at = now().toISOString();
	const event = (type: string, extra: Record<string, unknown> = {}) => ({
		type,
		actor: { kind: "orchestrator" },
		data: {
			questionId: first.id,
			attachment: authority.attachment,
			askingRunId: first.runId,
			stepId: first.stepId,
			...(first.groupId ? { groupId: first.groupId } : {}),
			...extra,
		},
	});
	if (command.actionId === "clarification.ack") {
		if (input.receipt !== state.delivery.id)
			reject("delivery acknowledgement identity mismatch");
		for (const question of questions) {
			if (question.clarification)
				question.clarification.delivery = {
					...state.delivery,
					status: "accepted",
					acceptedAt: at,
				};
		}
		return event("clarification.delivered");
	}
	if (command.actionId === "clarification.cancel") {
		for (const question of questions) {
			question.status = "cancelled";
			question.answeredAt = at;
			question.answer = { kind: "cancel" };
		}
		return event("developer.question.answered", { outcome: "cancelled" });
	}
	if (command.actionId === "clarification.stage") {
		const responses = input.responses;
		if (!responses) reject("a complete proposed response set is required");
		assertClarificationResponses(questions, responses);
		const version = (state.candidate?.version ?? 0) + 1;
		if (input.version !== version)
			reject("candidate version must advance exactly once");
		const proposal = authority.messages.find(
			(message) => message.messageId === input.proposalMessageId,
		);
		if (
			proposal?.role !== "assistant" ||
			proposal.hostId !== authority.attachment.hostId ||
			proposal.conversationId !== authority.attachment.conversationId ||
			!proposal.text.includes(
				renderClarificationProposal(questions, responses, version),
			)
		)
			reject(
				"native proposal does not present the exact versioned response set",
			);
		if (
			state.candidate &&
			proposal.sequence <= state.candidate.proposal.sequence
		)
			reject("edited candidates require a new assistant proposal");
		if (
			snapshot.developerDialogue.some(
				(question) =>
					!questions.includes(question) &&
					question.clarification?.candidate?.proposal.messageId ===
						proposal.messageId &&
					question.clarification.attachment.conversationId ===
						authority.attachment.conversationId &&
					question.clarification.attachment.hostId ===
						authority.attachment.hostId,
			)
		)
			reject("a proposal message cannot stage independent questions");
		const candidate = {
			version,
			responses: responses.map((response) => ({ ...response })),
			digest: clarificationDigest([
				snapshot.workflowId,
				authority.attachment,
				first.runId,
				version,
				responses,
			]),
			proposal: { messageId: proposal.messageId, sequence: proposal.sequence },
		};
		for (const question of questions)
			if (question.clarification)
				question.clarification.candidate = structuredClone(candidate);
		assertDialogueContentBound(snapshot.developerDialogue);
		return event("clarification.staged", {
			version,
			digest: candidate.digest,
			proposal: candidate.proposal,
			responses: candidate.responses,
		});
	}
	let responses: readonly ClarificationResponse[];
	let resolution: NonNullable<ClarificationState["resolution"]>;
	if (!input.receipt) reject("a stable answer receipt is required");
	if (command.actionId === "clarification.grounded") {
		if (!input.responses || !input.rationale || !input.sources?.length)
			reject(
				"grounded answers require complete responses, rationale and verified supporting sources",
			);
		responses = input.responses;
		assertClarificationResponses(questions, responses);
		if (
			input.sources.some(
				(source) =>
					!authority.sources.some(
						(verified) =>
							source.kind === verified.kind &&
							source.id === verified.id &&
							source.digest === verified.digest,
					),
			)
		)
			reject("grounding source identity or content changed");
		resolution = {
			origin: "grounded-orchestrator",
			rationale: input.rationale,
			sources: input.sources.map((source) => ({ ...source })),
			receipt: input.receipt,
		};
	} else if (command.actionId === "clarification.confirm") {
		if (input.responses !== undefined)
			reject(
				"confirmation relays only the persisted candidate, not replacement responses",
			);
		const candidate = state.candidate;
		if (!candidate || !input.version) reject("no current proposal to confirm");
		const proposal = authority.messages.find(
			(message) => message.messageId === candidate.proposal.messageId,
		);
		const confirmation = authority.messages.find(
			(message) => message.messageId === input.confirmationMessageId,
		);
		if (!proposal || !confirmation)
			reject("native proposal and developer confirmation are required");
		assertClarificationConfirmation(
			state,
			input.version,
			proposal,
			confirmation,
		);
		if (
			candidate.digest !==
				clarificationDigest([
					snapshot.workflowId,
					authority.attachment,
					first.runId,
					candidate.version,
					candidate.responses,
				]) ||
			!proposal.text.includes(
				renderClarificationProposal(
					questions,
					candidate.responses,
					candidate.version,
				),
			)
		)
			reject("proposal content or candidate digest changed");
		if (
			snapshot.developerDialogue.some(
				(question) =>
					!questions.includes(question) &&
					question.clarification?.attachment.hostId ===
						authority.attachment.hostId &&
					question.clarification.attachment.conversationId ===
						authority.attachment.conversationId &&
					question.clarification.resolution?.origin === "confirmed-developer" &&
					question.clarification.resolution.confirmation.messageId ===
						confirmation.messageId,
			)
		)
			reject(
				"developer confirmation has already been used for another question",
			);
		responses = candidate.responses;
		assertClarificationResponses(questions, responses);
		resolution = {
			origin: "confirmed-developer",
			candidateVersion: candidate.version,
			confirmation: {
				messageId: confirmation.messageId,
				sequence: confirmation.sequence,
			},
			receipt: input.receipt,
		};
	} else reject("unsupported clarification action");
	for (const [index, question] of questions.entries()) {
		const response = responses[index];
		if (!response || !question.clarification)
			reject("clarification response disappeared");
		question.status = "answered";
		question.answeredAt = at;
		question.answer = { kind: response.kind, value: response.value };
		question.clarification.resolution = structuredClone(resolution);
	}
	assertDialogueContentBound(snapshot.developerDialogue);
	return event("developer.question.answered", {
		outcome: "answered",
		origin: resolution.origin,
		resolution,
		responses,
		receipt: input.receipt,
	});
}
