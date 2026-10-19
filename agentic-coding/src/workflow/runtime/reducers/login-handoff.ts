// The `login-handoff.open` and `login-handoff.resolve` reducers
// (add-stage-interactive-login): the workflow-side record of a `stage_login`
// hand-off.
//
// The record exists so one developer surface can raise and resolve the hand-off
// that a browser session is waiting on. It is deliberately inert as workflow
// state: nothing here routes the record to the orchestrator, resumes a blocked
// run, or completes a step. The browser coordinator owns the outcome and asks
// for these records only to show and hear the *Done*/*Abort* answer.

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
	DeveloperDialogueRecord,
	WorkflowCommand,
	WorkflowSnapshot,
} from "../../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import {
	MAX_DEVELOPER_DIALOGUE_RECORDS,
	MAX_DIALOGUE_BYTES,
	questionRecordCount,
} from "../dialogue.ts";
import { nowIso } from "../store.ts";

/** The two answers a hand-off record offers, in the order the modal shows them. */
export const LOGIN_HANDOFF_OPTIONS = [
	{
		label: "Done",
		value: "done",
		description: "I finished logging in; verify it.",
	},
	{
		label: "Abort",
		value: "abort",
		description: "Cancel this hand-off.",
	},
] as const;

/** The one answer a hand-off whose ending is the server's own completion offers.
 * A *Done* there can only end the receiver without a token, so offering it would
 * promise a verification that cannot happen (`add-stage-oauth2-code-pkce`,
 * USAB-207). */
export const LOGIN_HANDOFF_ABORT_ONLY_OPTIONS = LOGIN_HANDOFF_OPTIONS.filter(
	(option) => option.value === "abort",
);

/** The run id a hand-off record carries. A hand-off belongs to no run: the
 * session outlives the run that opened it, and nothing routes or resumes by
 * this id — which is exactly why it is a value no run can ever have, so a build
 * that predates `kind` cannot mistake the record for a real question. */
export const LOGIN_HANDOFF_RUN_ID = "login-handoff";

/** The workflow role a hand-off belongs to: the role of the run that owns the
 * browser session, as far as the snapshot knows it. */
function lastRole(snapshot: WorkflowSnapshot): string {
	return (
		snapshot.step.results.at(-1)?.role ??
		snapshot.step.selectedRoles.at(-1) ??
		"developer"
	);
}

export function loginHandoffOpen(
	_db: Database,
	snapshot: WorkflowSnapshot,
	command: Extract<WorkflowCommand, { type: "login-handoff.open" }>,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	if (snapshot.status === "completed" || snapshot.status === "closed")
		throw new WorkflowRuntimeError(
			"invalid-command",
			"a terminal workflow cannot open a login hand-off",
		);
	const existing = snapshot.developerDialogue.find(
		(item) => item.id === command.recordId,
	);
	// The server resolves the record it opened, so a repeat is the same hand-off
	// (a restarted server, a retried dispatch) rather than a second dialog.
	if (existing) {
		if (existing.kind !== "login-handoff")
			throw new WorkflowRuntimeError(
				"invalid-command",
				"that dialogue record is not a login hand-off",
			);
		return {
			type: "developer.question.created",
			actor: { kind: "system" },
			data: {
				questionId: existing.id,
				role: existing.role,
				kind: "login-handoff",
				replayed: true,
			},
		};
	}
	// Hand-off records are bounded by the dialogue byte budget rather than by the
	// question-count budget, so a series of hand-offs never spends the slots a
	// run's real questions need. The count is the shared one for exactly that
	// reason: the question and consult writers count the same way.
	if (
		questionRecordCount(snapshot.developerDialogue) + 1 >
		MAX_DEVELOPER_DIALOGUE_RECORDS
	)
		throw new WorkflowRuntimeError(
			"dialogue-bounds",
			"developer dialogue limit reached; resolve the existing questions first",
		);
	const createdAt = nowIso(now);
	const record: DeveloperDialogueRecord = {
		id: command.recordId,
		workflowId: snapshot.workflowId,
		// Never the asking run: a build that predates `kind` decodes this record and
		// resumes whatever run its `runId` names, and no run may ever be named here.
		runId: LOGIN_HANDOFF_RUN_ID,
		stepId: command.stepId ?? snapshot.currentStep,
		role: command.role ?? lastRole(snapshot),
		kind: "login-handoff",
		description: command.description,
		...(command.context === undefined ? {} : { context: command.context }),
		options: (command.canConfirm === false
			? LOGIN_HANDOFF_ABORT_ONLY_OPTIONS
			: LOGIN_HANDOFF_OPTIONS
		).map((option) => ({ ...option })),
		// The record expires on the existing question timer, at the hand-off's own
		// deadline. The timer only unlists the dialog: the browser coordinator
		// still owns the ending, and an expired record is simply no answer.
		timerNonce: randomUUID(),
		status: "pending",
		createdAt,
		expiresAt: command.expiresAt,
	};
	const nextDialogue = [...snapshot.developerDialogue, record];
	if (Buffer.byteLength(JSON.stringify(nextDialogue)) > MAX_DIALOGUE_BYTES)
		throw new WorkflowRuntimeError(
			"dialogue-bounds",
			"developer dialogue content limit reached; shorten the hand-off description",
		);
	snapshot.developerDialogue.push(record);
	return {
		type: "developer.question.created",
		actor: { kind: "system" },
		data: {
			questionId: record.id,
			role: record.role,
			kind: "login-handoff",
		},
	};
}

export function loginHandoffResolve(
	_db: Database,
	snapshot: WorkflowSnapshot,
	command: Extract<WorkflowCommand, { type: "login-handoff.resolve" }>,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	const record = snapshot.developerDialogue.find(
		(item) => item.id === command.recordId,
	);
	if (record?.kind !== "login-handoff")
		throw new WorkflowRuntimeError(
			"invalid-command",
			"that dialogue record is not a login hand-off",
		);
	// Resolving an already-resolved hand-off is the same resolution: the
	// coordinator may be racing a deadline or a closed window.
	if (record.status !== "pending")
		return {
			type: "developer.question.answered",
			actor: { kind: "system" },
			data: {
				questionId: record.id,
				outcome: record.status === "answered" ? "answered" : record.status,
				kind: "login-handoff",
				replayed: true,
			},
		};
	record.status = command.answer === "abort" ? "cancelled" : "answered";
	record.answeredAt = nowIso(now);
	record.answer = { kind: "option", value: command.answer };
	return {
		type: "developer.question.answered",
		actor: { kind: "system" },
		data: {
			questionId: record.id,
			outcome: command.answer === "abort" ? "cancelled" : "answered",
			kind: "login-handoff",
		},
	};
}
