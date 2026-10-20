// The `agent.checkpoint` reducer (efficiency backlog item 19): one run's
// run-progress checkpoint decision, appended to the bounded classifier-decision
// history. It is diagnostic history and nothing else — it never transitions,
// never touches a step's run set, and never changes the snapshot's status — so
// the worst a lost, refused or malformed record can do is leave the run where it
// already was.
//
// The caller is the run itself, like `agent.resume` and the delegated debug
// commands: it resolves its own identity from its launch environment and this
// reducer validates the retained capability inside the command transaction.
import type { Database } from "bun:sqlite";
import type {
	ClassifierDecisionRecord,
	WorkflowCommand,
	WorkflowSnapshot,
} from "../../../contracts/workflow.ts";
import { CHECKPOINT_RECORD_LIMIT } from "../../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../../contracts.ts";
import { tokenMatches } from "../capability.ts";
import { ACTIVE_RUN, nowIso, type RunRow, runFromRow } from "../store.ts";
import {
	appendClassifierDecisions,
	truncateClassifierInput,
} from "./effect-result.ts";

/** The integration name every record of this feature carries. The dashboard
 * reads it, the CLI refuses any other value, and the host's own telemetry
 * envelope uses the same string. */
export const CHECKPOINT_RECORD_INTEGRATION = "progress-checkpoint";

export interface RecordedCheckpoint {
	recorded: boolean;
	/** Why nothing was appended, for the caller's log line. */
	reason?: "record-cap" | "storage-error";
	/** How many checkpoint records the workflow holds after this command. */
	records: number;
}

export function agentCheckpoint(
	db: Database,
	snapshot: WorkflowSnapshot,
	command: Extract<WorkflowCommand, { type: "agent.checkpoint" }>,
	now: () => Date,
): { type: string; actor: unknown; data: unknown } {
	const row = db
		.query("SELECT * FROM workflow_runs WHERE id=?")
		.get(command.runId) as RunRow | null;
	if (!row) throw new WorkflowRuntimeError("unauthorized", "unknown run");
	const run = runFromRow(row);
	if (
		run.workflowId !== snapshot.workflowId ||
		(command.generation !== undefined &&
			run.generation !== command.generation) ||
		!ACTIVE_RUN.has(run.status) ||
		run.stepId !== snapshot.currentStep ||
		run.stepId !== command.stepId ||
		run.role !== command.role ||
		!snapshot.step.activeRunIds.includes(run.id)
	)
		throw new WorkflowRuntimeError("stale-run", "run is stale or inactive");
	if (
		!run.capabilityHash ||
		!tokenMatches(command.token, run.capabilityHash) ||
		Date.parse(run.capabilityExpiresAt) <= now().getTime()
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"invalid or expired run capability",
		);
	if (command.record.integration !== CHECKPOINT_RECORD_INTEGRATION)
		throw new WorkflowRuntimeError(
			"invalid-command",
			`checkpoint records must carry integration "${CHECKPOINT_RECORD_INTEGRATION}"`,
		);
	const record: ClassifierDecisionRecord = {
		id: [
			snapshot.workflowId,
			snapshot.revision,
			CHECKPOINT_RECORD_INTEGRATION,
			command.record.questionId,
		].join(":"),
		at: nowIso(now),
		integration: CHECKPOINT_RECORD_INTEGRATION,
		...(command.record.phase === undefined
			? {}
			: { phase: command.record.phase }),
		questionId: command.record.questionId,
		model: command.record.model,
		...truncateClassifierInput(command.record.input),
		options: [...command.record.options],
		answer: { ...command.record.answer },
		result: {
			applied: command.record.result.applied,
			profiles: [...command.record.result.profiles],
			...(command.record.result.attention === undefined
				? {}
				: { attention: command.record.result.attention }),
		},
	};
	const before = checkpointRecords(snapshot).length;
	if (before >= CHECKPOINT_RECORD_LIMIT)
		return {
			type: "agent.checkpoint",
			actor: { kind: "agent", runId: run.id, role: run.role },
			data: {
				recorded: false,
				reason: "record-cap",
				records: before,
			} satisfies RecordedCheckpoint,
		};
	try {
		appendClassifierDecisions(snapshot, [record]);
	} catch {
		// History is diagnostic: a record that cannot be stored must never fail
		// the command that recorded it.
		return {
			type: "agent.checkpoint",
			actor: { kind: "agent", runId: run.id, role: run.role },
			data: {
				recorded: false,
				reason: "storage-error",
				records: before,
			} satisfies RecordedCheckpoint,
		};
	}
	return {
		type: "agent.checkpoint",
		actor: { kind: "agent", runId: run.id, role: run.role },
		data: {
			recorded: true,
			records: checkpointRecords(snapshot).length,
		} satisfies RecordedCheckpoint,
	};
}

/** How many checkpoint records this workflow's bounded history holds: the cap
 * is per feature, so a long run cannot crowd the classifier history out of its
 * own budget. */
export function checkpointRecords(
	snapshot: WorkflowSnapshot,
): ClassifierDecisionRecord[] {
	return (snapshot.classifierDecisions ?? []).filter(
		(record) => record.integration === CHECKPOINT_RECORD_INTEGRATION,
	);
}
