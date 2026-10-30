// The `agent.question` and `agent.question-expire` reducers, grouped
// together since both resolve their run through the same `questionRun`
// dialogue check. Moved verbatim out of runtime.ts's `reduce()` dispatch
// (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { ordinaryClarification } from "../../../contracts/clarification.ts";
import {
	type DeveloperDialogueRecord,
	type DeveloperQuestionItem,
	resolveDeveloperQuestionOption,
	type WorkflowCommand,
	type WorkflowSnapshot,
} from "../../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import { clarificationDeliveryId } from "../clarification-actions.ts";
import {
	MAX_DEVELOPER_DIALOGUE_RECORDS,
	MAX_DIALOGUE_BYTES,
	QUESTION_WAIT_MS,
	questionRecordCount,
	questionRun,
} from "../dialogue.ts";
import { nowIso } from "../store.ts";

export function agentQuestion(
	db: Database,
	snapshot: WorkflowSnapshot,
	command: Extract<WorkflowCommand, { type: "agent.question" }>,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	const run = questionRun(db, snapshot, command, now);
	const items: readonly DeveloperQuestionItem[] = command.questions ?? [
		{
			...(command.description === undefined
				? {}
				: { description: command.description }),
			...(command.context === undefined ? {} : { context: command.context }),
			options: command.options ?? [],
		},
	];
	if (
		questionRecordCount(snapshot.developerDialogue) + items.length >
		MAX_DEVELOPER_DIALOGUE_RECORDS
	)
		throw new WorkflowRuntimeError(
			"dialogue-bounds",
			"developer dialogue limit reached; resolve the existing questions before asking again",
		);
	const grouped = command.questions !== undefined;
	const groupId = grouped ? randomUUID() : undefined;
	const createdAt = nowIso(now);
	const expiresAt = new Date(now().getTime() + QUESTION_WAIT_MS).toISOString();
	// Orchestrator-started workflows route a developer question to the
	// orchestrator session first (route-developer-questions-through-orchestrator):
	// the record is marked `targetRole: "orchestrator"`, which keeps it out of the
	// developer's pending set until the orchestrator either answers it or forwards
	// it (clearing the marker). The orchestrator is not a workflow run, so there is
	// no `targetRunId`; its standing capability, not a per-question nonce,
	// authorizes its answer.
	const attachment = snapshot.metadata.clarificationAttachment;
	const orchestratorFirst = attachment !== undefined;
	const questions = items.map(
		(item, itemIndex): DeveloperDialogueRecord => ({
			id: randomUUID(),
			workflowId: snapshot.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			description: item.question ?? item.description ?? "",
			...(item.ident === undefined ? {} : { ident: item.ident }),
			...(item.context === undefined ? {} : { context: item.context }),
			options: item.options.map(resolveDeveloperQuestionOption),
			...(groupId === undefined ? {} : { groupId, itemIndex }),
			...(orchestratorFirst ? { targetRole: "orchestrator" } : {}),
			timerNonce: randomUUID(),
			status: "pending",
			createdAt,
			expiresAt,
		}),
	);
	if (attachment)
		for (const question of questions)
			question.clarification = {
				attachment: { ...attachment },
				delivery: {
					id: clarificationDeliveryId(
						snapshot.workflowId,
						groupId ?? question.id,
						attachment.epoch,
					),
					status: "pending",
				},
			};
	const nextDialogue = [...snapshot.developerDialogue, ...questions];
	if (Buffer.byteLength(JSON.stringify(nextDialogue)) > MAX_DIALOGUE_BYTES)
		throw new WorkflowRuntimeError(
			"dialogue-bounds",
			"developer dialogue content limit reached; shorten the question or options",
		);
	snapshot.developerDialogue.push(...questions);
	return {
		type: "developer.question.created",
		actor: { kind: "agent", runId: run.id, role: run.role },
		data: {
			...(groupId === undefined
				? { questionId: questions[0]?.id }
				: { groupId, questionIds: questions.map((question) => question.id) }),
			role: run.role,
		},
	};
}

export function markQuestionWait(
	db: Database,
	snapshot: WorkflowSnapshot,
	command: Extract<WorkflowCommand, { type: "agent.question-wait" }>,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	const run = questionRun(db, snapshot, command, now);
	const question = snapshot.developerDialogue.find(
		(item) => item.id === command.questionId && item.runId === run.id,
	);
	if (!question || !ordinaryClarification(question))
		throw new WorkflowRuntimeError(
			"stale-question",
			"attached clarification not found",
		);
	const group = question.groupId
		? snapshot.developerDialogue.filter(
				(item) => item.groupId === question.groupId,
			)
		: [question];
	for (const item of group) {
		if (item.status !== "pending") continue;
		item.clarificationAwaitingHandoff = true;
		if (item.clarification) item.clarification.awaitingHandoff = true;
	}
	return {
		type: "clarification.waiting",
		actor: { kind: "agent", runId: run.id, role: run.role },
		data: { questionId: question.id },
	};
}

export function expireQuestionTimer(
	_snapshotDb: Database,
	snapshot: WorkflowSnapshot,
	command: Extract<WorkflowCommand, { type: "timer.question-expire" }>,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	if (snapshot.status === "completed" || snapshot.status === "closed")
		throw new WorkflowRuntimeError(
			"stale-question",
			"terminal workflows do not accept question timers",
		);
	const question = snapshot.developerDialogue.find(
		(item) => item.id === command.questionId,
	);
	if (question?.timerNonce !== command.timerNonce)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"question timer capability is invalid",
		);
	if (question?.status !== "pending")
		throw new WorkflowRuntimeError(
			"stale-question",
			"question is no longer pending",
		);
	if (Date.parse(question.expiresAt) > now().getTime())
		throw new WorkflowRuntimeError(
			"stale-question",
			"question has not expired",
		);
	if (ordinaryClarification(question))
		return {
			type: "clarification.overdue",
			actor: { kind: "system" },
			data: {
				questionId: question.id,
				...(question.groupId ? { groupId: question.groupId } : {}),
			},
		};
	const group = question.groupId
		? snapshot.developerDialogue.filter(
				(item) =>
					item.groupId === question.groupId && item.status === "pending",
			)
		: [question];
	const at = nowIso(now);
	for (const item of group) {
		item.status = "expired";
		item.answeredAt = at;
		item.answer = { kind: "cancel" };
	}
	return {
		type: "developer.question.expired",
		actor: { kind: "system" },
		data: {
			...(question.groupId
				? { groupId: question.groupId }
				: { questionId: question.id }),
			outcome: "expired",
		},
	};
}

export function expireQuestion(
	db: Database,
	snapshot: WorkflowSnapshot,
	command: Extract<WorkflowCommand, { type: "agent.question-expire" }>,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	const run = questionRun(db, snapshot, command, now);
	const question = snapshot.developerDialogue.find(
		(item) => item.id === command.questionId && item.runId === run.id,
	);
	if (question?.status !== "pending")
		throw new WorkflowRuntimeError(
			"stale-question",
			"question is no longer pending",
		);
	if (ordinaryClarification(question))
		return {
			type: "clarification.overdue",
			actor: { kind: "agent", runId: run.id, role: run.role },
			data: { questionId: question.id },
		};
	const group = question.groupId
		? snapshot.developerDialogue.filter(
				(item) =>
					item.groupId === question.groupId && item.status === "pending",
			)
		: [question];
	const at = nowIso(now);
	for (const item of group) {
		item.status = "expired";
		item.answeredAt = at;
		item.answer = { kind: "cancel" };
	}
	return {
		type: "developer.question.expired",
		actor: { kind: "agent", runId: run.id, role: run.role },
		data: {
			...(question.groupId
				? { groupId: question.groupId }
				: { questionId: question.id }),
			outcome: "expired",
		},
	};
}
