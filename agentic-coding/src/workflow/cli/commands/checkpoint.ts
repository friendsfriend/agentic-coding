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
	checkpointRecordProblems,
	runCheckpointRecords,
} from "../../runtime/reducers/agent-checkpoint.ts";
import type { WorkflowEngine } from "../../runtime.ts";
import { parseInlineJson, requireFlag } from "../args.ts";
import { managedWorkflowTarget } from "../caller-environment.ts";
import { resolveHandoffIdentity } from "../identity.ts";

type App = WorkflowApplication;

/** The choice a `--record` payload claims, already validated as one of the five
 * actions by `checkpointRecordProblems`. */
function answerChoice(answer: unknown): string | undefined {
	if (typeof answer !== "object" || answer === null) return undefined;
	const choice = (answer as Record<string, unknown>).choice;
	return typeof choice === "string" ? choice : undefined;
}

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
	/** Why the record was not stored: the run's record cap, a `duplicate` — the
	 * history already holds another decision under this id — or the reducer's own
	 * `not-stored` / refusal message. */
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
	// The record is rendered in the developer's dashboard and measured by the
	// efficiency queries, so the boundary that persists it enforces the feature's
	// closed vocabulary and its content-free digest for every caller — the
	// reducer enforces the same rules again inside the command transaction.
	const problems = checkpointRecordProblems(
		record,
		identity.runId,
		CHECKPOINT_RECORD_LIMIT,
	);
	if (problems.length > 0)
		throw new Error(`checkpoint: --record refused: ${problems[0]}`);
	const questionId = record.questionId as string;
	const readSnapshot = () =>
		application
			? application.runSync(
					workflowEngine.getSnapshotEffect(target, identity.workflowId),
				)
			: workflowEngine.getSnapshot(target, identity.workflowId);
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
		// The verdict is read from the snapshot this very command committed — the
		// reducer's own answer — never from a count compared across two reads that
		// another workflow run may have moved in between.
		const committed = application
			? application.runSync(workflowEngine.dispatchEffect(target, command))
			: workflowEngine.dispatch(target, command);
		const records = runCheckpointRecords(committed.snapshot, identity.runId);
		// The history holds a record under this id, but the answer says *this*
		// decision was stored: a stored record that names the same id with another
		// digest or answer is a different decision (a relaunched run re-issuing an
		// ordinal), and reporting it as this call's own would let a caller believe a
		// decision the history never took.
		const stored = records.find((entry) => entry.questionId === questionId);
		const recorded =
			stored !== undefined &&
			stored.input === record.input &&
			stored.answer.choice === answerChoice(record.answer);
		console.log(
			JSON.stringify({
				...base,
				recorded,
				records: records.length,
				...(recorded
					? {}
					: {
							reason:
								stored !== undefined
									? "duplicate"
									: records.length >= CHECKPOINT_RECORD_LIMIT
										? "record-cap"
										: "not-stored",
						}),
			} satisfies CheckpointRecordView),
		);
	} catch (error) {
		// A refused record leaves the workflow exactly where it was; the caller
		// reports it and keeps working (fail-open).
		console.log(
			JSON.stringify({
				...base,
				recorded: false,
				records: runCheckpointRecords(readSnapshot(), identity.runId).length,
				reason: error instanceof Error ? error.message : String(error),
			} satisfies CheckpointRecordView),
		);
	}
}
