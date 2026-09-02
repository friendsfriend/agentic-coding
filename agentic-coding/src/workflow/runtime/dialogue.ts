// Developer-question dialogue: resolving the run a question command acts on,
// answering a question or questionnaire, and marking questions expired.
// Self-contained, snapshot-in/snapshot-out, needing only the clock. Moved
// verbatim out of runtime.ts (split-workflow-god-modules).
import type { Database } from "bun:sqlite";
import type { WorkflowRun, WorkflowSnapshot } from "../contracts.ts";
import {
	type DeveloperQuestionAnswer,
	parseDeveloperQuestionAnswer,
	WorkflowRuntimeError,
} from "../contracts.ts";
import { tokenMatches } from "./capability.ts";
import { ACTIVE_RUN, nowIso, type RunRow, runFromRow } from "./store.ts";

export const MAX_DEVELOPER_DIALOGUE_RECORDS = 100;
export const QUESTION_WAIT_MS = 24 * 60 * 60_000;

export function questionRun(
	db: Database,
	snapshot: WorkflowSnapshot,
	command: {
		workflowId: string;
		runId: string;
		stepId: string;
		role: string;
		token: string;
	},
	now: () => Date,
): WorkflowRun {
	const row = db
		.query("SELECT * FROM workflow_runs WHERE id=?")
		.get(command.runId) as RunRow | null;
	if (!row) throw new WorkflowRuntimeError("unauthorized", "unknown run");
	const run = runFromRow(row);
	if (
		run.workflowId !== snapshot.workflowId ||
		command.workflowId !== snapshot.workflowId ||
		run.stepId !== command.stepId ||
		run.role !== command.role ||
		run.stepId !== snapshot.currentStep ||
		!snapshot.step.activeRunIds.includes(run.id) ||
		!ACTIVE_RUN.has(run.status) ||
		!run.capabilityHash ||
		!tokenMatches(command.token, run.capabilityHash) ||
		Date.parse(run.capabilityExpiresAt) <= now().getTime()
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"invalid or inactive run capability",
		);
	return run;
}

export function expireQuestions(
	snapshot: WorkflowSnapshot,
	runIds: string[],
	now: () => Date,
): void {
	const expired = new Set(runIds);
	const at = nowIso(now);
	for (const question of snapshot.developerDialogue)
		if (question.status === "pending" && expired.has(question.runId)) {
			question.status = "expired";
			question.answeredAt = at;
			question.answer = { kind: "cancel" };
		}
}

export function answerQuestion(
	snapshot: WorkflowSnapshot,
	raw: unknown,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	let answer: DeveloperQuestionAnswer;
	try {
		answer = parseDeveloperQuestionAnswer(raw);
	} catch (error) {
		throw new WorkflowRuntimeError(
			"invalid-command",
			error instanceof Error ? error.message : String(error),
		);
	}
	if ("groupId" in answer) {
		const group = snapshot.developerDialogue
			.filter((item) => item.groupId === answer.groupId)
			.sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0));
		if (!group.length || group.some((item) => item.status !== "pending"))
			throw new WorkflowRuntimeError(
				"stale-question",
				"questionnaire is no longer pending",
			);
		if (group.some((item) => Date.parse(item.expiresAt) <= now().getTime())) {
			const at = nowIso(now);
			for (const item of group) {
				item.status = "expired";
				item.answeredAt = at;
				item.answer = { kind: "cancel" };
			}
			return {
				type: "developer.question.expired",
				actor: { kind: "system" },
				data: { groupId: answer.groupId, outcome: "expired" },
			};
		}
		if (!("responses" in answer)) {
			const at = nowIso(now);
			for (const item of group) {
				item.status = "cancelled";
				item.answeredAt = at;
				item.answer = { kind: "cancel" };
			}
			return {
				type: "developer.question.answered",
				actor: { kind: "developer" },
				data: { groupId: answer.groupId, outcome: "cancelled" },
			};
		}
		if (answer.responses.length !== group.length)
			throw new WorkflowRuntimeError(
				"invalid-command",
				"questionnaire responses must include every item exactly once",
			);
		const byId = new Map(group.map((item) => [item.id, item]));
		for (const response of answer.responses) {
			const item = byId.get(response.questionId);
			if (!item)
				throw new WorkflowRuntimeError(
					"invalid-command",
					"questionnaire response does not match its items",
				);
			if (
				response.kind === "option" &&
				!item.options.some((option) => option.value === response.value)
			)
				throw new WorkflowRuntimeError(
					"invalid-command",
					"answer is not a recommended option",
				);
			if (response.kind === "custom" && !response.value.trim())
				throw new WorkflowRuntimeError(
					"invalid-command",
					"custom answer must not be empty",
				);
		}
		const at = nowIso(now);
		for (const response of answer.responses) {
			const item = byId.get(response.questionId);
			if (!item) continue;
			item.status = "answered";
			item.answeredAt = at;
			item.answer = { kind: response.kind, value: response.value };
		}
		return {
			type: "developer.question.answered",
			actor: { kind: "developer" },
			data: { groupId: answer.groupId, outcome: "answered" },
		};
	}
	const question = snapshot.developerDialogue.find(
		(item) => item.id === answer.questionId,
	);
	if (question?.groupId) {
		const groupSize = snapshot.developerDialogue.filter(
			(item) => item.groupId === question.groupId,
		).length;
		if (groupSize > 1)
			throw new WorkflowRuntimeError(
				"invalid-command",
				"questionnaire requires a complete grouped response set",
			);
	}
	if (question?.status !== "pending")
		throw new WorkflowRuntimeError(
			"stale-question",
			"question is no longer pending",
		);
	if (Date.parse(question.expiresAt) <= now().getTime()) {
		question.status = "expired";
		question.answeredAt = nowIso(now);
		question.answer = { kind: "cancel" };
		return {
			type: "developer.question.expired",
			actor: { kind: "system" },
			data: { questionId: question.id, outcome: "expired" },
		};
	}
	if (answer.kind === "option") {
		if (!question.options.some((option) => option.value === answer.value))
			throw new WorkflowRuntimeError(
				"invalid-command",
				"answer is not a recommended option",
			);
	} else if (answer.kind === "custom" && !answer.value?.trim()) {
		throw new WorkflowRuntimeError(
			"invalid-command",
			"custom answer must not be empty",
		);
	}
	question.status = answer.kind === "cancel" ? "cancelled" : "answered";
	question.answeredAt = nowIso(now);
	question.answer = {
		kind: answer.kind,
		...(answer.value === undefined ? {} : { value: answer.value }),
	};
	return {
		type: "developer.question.answered",
		actor: { kind: "developer" },
		data: { questionId: question.id, outcome: question.status },
	};
}
