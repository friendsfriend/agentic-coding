// `checkpoint`: record one run-progress checkpoint decision (efficiency backlog
// item 19). Local by design, like `resume-run` and the delegated debug
// commands: the caller is the run itself, resolves its own identity from its
// launch environment, and the reducer validates the retained capability inside
// the command transaction. Nothing transitions, so nothing drains: the record is
// diagnostic history.
import { CHECKPOINT_RECORD_LIMIT } from "../../../contracts/workflow.ts";
import type { WorkflowApplication } from "../../application.ts";
import {
	CHECKPOINT_RECORD_INTEGRATION,
	checkpointRecords,
} from "../../runtime/reducers/agent-checkpoint.ts";
import type { WorkflowEngine } from "../../runtime.ts";
import { parseInlineJson, requireFlag } from "../args.ts";
import { managedWorkflowTarget } from "../caller-environment.ts";
import { resolveHandoffIdentity } from "../identity.ts";

type App = WorkflowApplication;

/** What one `checkpoint --record` call answers with: the record's fate, never a
 * state edit the caller may apply. A refused or dropped record is reported as
 * such and the run keeps working — the checkpoint is fail-open by contract. */
export interface CheckpointRecordView {
	readonly runId: string;
	readonly workflowId: string;
	readonly stepId: string;
	readonly role: string;
	readonly recorded: boolean;
	readonly records?: number;
	readonly reason?: string;
}

export function runCheckpoint(
	rest: string[],
	workflowEngine: WorkflowEngine,
	application?: App,
	/** The workflow target, resolved from the environment by default; explicit
	 * so a focused test can name the checkout it built. */
	target = managedWorkflowTarget(),
): void {
	const raw = requireFlag(rest, "record");
	const parsed = parseInlineJson(raw, "checkpoint --record");
	if (typeof parsed !== "object" || parsed === null)
		throw new Error("checkpoint: --record must be a JSON object");
	const record = parsed as Record<string, unknown>;
	if (record.integration !== CHECKPOINT_RECORD_INTEGRATION)
		throw new Error(
			`checkpoint: --record integration must be "${CHECKPOINT_RECORD_INTEGRATION}"`,
		);
	const identity = resolveHandoffIdentity(workflowEngine, target, application);
	const readSnapshot = () =>
		application
			? application.runSync(
					workflowEngine.getSnapshotEffect(target, identity.workflowId),
				)
			: workflowEngine.getSnapshot(target, identity.workflowId);
	const before = checkpointRecords(readSnapshot()).length;
	const command = {
		type: "agent.checkpoint",
		workflowId: identity.workflowId,
		runId: identity.runId,
		stepId: identity.stepId,
		role: identity.role,
		token: identity.token,
		generation: identity.generation,
		record,
	} as const;
	const base = {
		runId: identity.runId,
		workflowId: identity.workflowId,
		stepId: identity.stepId,
		role: identity.role,
	};
	try {
		if (application)
			application.runSync(workflowEngine.dispatchEffect(target, command));
		else workflowEngine.dispatch(target, command);
	} catch (error) {
		// A refused record leaves the workflow exactly where it was; the caller
		// reports it and keeps working (fail-open).
		console.log(
			JSON.stringify({
				...base,
				recorded: false,
				records: before,
				reason: error instanceof Error ? error.message : String(error),
			} satisfies CheckpointRecordView),
		);
		return;
	}
	const records = checkpointRecords(readSnapshot()).length;
	console.log(
		JSON.stringify(
			records > before
				? { ...base, recorded: true, records }
				: {
						...base,
						recorded: false,
						records,
						reason:
							before >= CHECKPOINT_RECORD_LIMIT ? "record-cap" : "not-stored",
					},
		),
	);
}
