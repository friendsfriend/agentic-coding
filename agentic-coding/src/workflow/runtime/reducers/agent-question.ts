// The `agent.question` and `agent.question-expire` reducers, grouped
// together since both resolve their run through the same `questionRun`
// dialogue check. Moved verbatim out of runtime.ts's `reduce()` dispatch
// (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
	DeveloperDialogueRecord,
	DeveloperQuestionItem,
	WorkflowCommand,
	WorkflowSnapshot,
} from "../../contracts.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import {
	MAX_DEVELOPER_DIALOGUE_RECORDS,
	QUESTION_WAIT_MS,
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
			description: command.description ?? "",
			...(command.context === undefined ? {} : { context: command.context }),
			options: command.options ?? [],
		},
	];
	if (
		snapshot.developerDialogue.length + items.length >
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
	const questions = items.map(
		(item, itemIndex): DeveloperDialogueRecord => ({
			id: randomUUID(),
			workflowId: snapshot.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			description: item.description,
			...(item.context === undefined ? {} : { context: item.context }),
			options: item.options,
			...(groupId === undefined ? {} : { groupId, itemIndex }),
			status: "pending",
			createdAt,
			expiresAt,
		}),
	);
	const nextDialogue = [...snapshot.developerDialogue, ...questions];
	if (Buffer.byteLength(JSON.stringify(nextDialogue)) > 128 * 1024)
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
