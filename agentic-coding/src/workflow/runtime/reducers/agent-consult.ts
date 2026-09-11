// The `agent.ask` and `agent.answer` reducers: a managed agent asks a
// clarification question of a peer role whose step already completed in this
// workflow instance, the engine re-prompts that peer's still-live persistent
// session through the durable outbox, and the peer answers into the same
// bounded dialogue record the developer-question path already uses.
//
// Reusing `developerDialogue` keeps the count/content bounds, the lazy timer
// expiry, and the authenticated answer path identical; the only added fields
// are the peer target and the one-shot answer nonce (stored hashed).
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
	DeveloperDialogueRecord,
	WorkflowCommand,
	WorkflowSnapshot,
} from "../../contracts.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import { tokenMatches } from "../capability.ts";
import {
	MAX_DEVELOPER_DIALOGUE_RECORDS,
	QUESTION_WAIT_MS,
	questionRun,
} from "../dialogue.ts";
import { enqueue } from "../kernel.ts";
import { nowIso, type RunRow, runFromRow, runs } from "../store.ts";

const MAX_DIALOGUE_BYTES = 128 * 1024;

/** The latest completed, still-live run for `targetRole` outside the current
 * step. Only roles from already-completed steps are consultable, which keeps
 * the allowed peer set tied to the workflow definition that actually ran. */
function completedRoleRun(
	db: Database,
	snapshot: WorkflowSnapshot,
	targetRole: string,
	askerRunId: string,
): ReturnType<typeof runFromRow> | undefined {
	return runs(db, snapshot.workflowId)
		.filter(
			(run) =>
				run.role === targetRole &&
				run.stepId !== snapshot.currentStep &&
				run.status === "completed" &&
				run.id !== askerRunId &&
				run.handle !== undefined,
		)
		.at(-1);
}

export function agentAsk(
	db: Database,
	snapshot: WorkflowSnapshot,
	command: Extract<WorkflowCommand, { type: "agent.ask" }>,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	const run = questionRun(db, snapshot, command, now);
	const target = completedRoleRun(db, snapshot, command.targetRole, run.id);
	if (!target)
		throw new WorkflowRuntimeError(
			"unavailable",
			`no completed agent is available for role ${command.targetRole}`,
		);
	if (snapshot.developerDialogue.length + 1 > MAX_DEVELOPER_DIALOGUE_RECORDS)
		throw new WorkflowRuntimeError(
			"dialogue-bounds",
			"dialogue limit reached; resolve the existing questions before asking again",
		);
	const createdAt = nowIso(now);
	const expiresAt = new Date(now().getTime() + QUESTION_WAIT_MS).toISOString();
	const question: DeveloperDialogueRecord = {
		id: randomUUID(),
		workflowId: snapshot.workflowId,
		runId: run.id,
		stepId: run.stepId,
		role: run.role,
		description: command.description,
		...(command.context === undefined ? {} : { context: command.context }),
		options: command.options ?? [],
		timerNonce: randomUUID(),
		targetRole: target.role,
		targetRunId: target.id,
		status: "pending",
		createdAt,
		expiresAt,
	};
	if (
		Buffer.byteLength(
			JSON.stringify([...snapshot.developerDialogue, question]),
		) > MAX_DIALOGUE_BYTES
	)
		throw new WorkflowRuntimeError(
			"dialogue-bounds",
			"dialogue content limit reached; shorten the question or options",
		);
	snapshot.developerDialogue.push(question);
	// The one-shot answer nonce is minted and delivered only when the prompt is
	// actually executed, so the durable outbox row never carries it.
	enqueue(db, snapshot, "agent.prompt", `run:${target.id}:ask:${question.id}`, {
		runId: target.id,
		questionId: question.id,
	});
	return {
		type: "agent.question.created",
		actor: { kind: "agent", runId: run.id, role: run.role },
		data: {
			questionId: question.id,
			targetRole: target.role,
			targetRunId: target.id,
		},
	};
}

export function agentAnswer(
	db: Database,
	snapshot: WorkflowSnapshot,
	command: Extract<WorkflowCommand, { type: "agent.answer" }>,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	const row = db
		.query("SELECT * FROM workflow_runs WHERE id=?")
		.get(command.runId) as RunRow | null;
	if (!row) throw new WorkflowRuntimeError("unauthorized", "unknown run");
	const run = runFromRow(row);
	if (
		run.workflowId !== snapshot.workflowId ||
		command.workflowId !== snapshot.workflowId ||
		run.role !== command.role ||
		run.stepId !== command.stepId
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"question answer identity mismatch",
		);
	const question = snapshot.developerDialogue.find(
		(item) => item.id === command.questionId,
	);
	if (
		!question ||
		question.targetRunId !== run.id ||
		question.targetRole !== run.role
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"question is not addressed to this run",
		);
	if (question.status !== "pending")
		throw new WorkflowRuntimeError(
			"stale-question",
			"question is no longer pending",
		);
	if (
		!question.answerNonceHash ||
		!tokenMatches(command.answerNonce, question.answerNonceHash)
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"question answer capability is invalid",
		);
	const at = nowIso(now);
	if (Date.parse(question.expiresAt) <= now().getTime()) {
		question.status = "expired";
		question.answeredAt = at;
		question.answer = { kind: "cancel" };
		return {
			type: "agent.question.expired",
			actor: { kind: "agent", runId: run.id, role: run.role },
			data: { questionId: question.id, outcome: "expired" },
		};
	}
	question.status = "answered";
	question.answeredAt = at;
	question.answer = { kind: "custom", value: command.answer };
	return {
		type: "agent.question.answered",
		actor: { kind: "agent", runId: run.id, role: run.role },
		data: { questionId: question.id, outcome: "answered" },
	};
}
