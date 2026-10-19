// The dataset build's run-window alarm (efficiency backlog item 20: a run's
// window is its session's window).
//
// A run's window is the engine's — `started_at` to the `agent.handoff` that
// closed it — and a session outlives the run: one pi-durable conversation serves
// every later run of the same step and role. Before the session window was
// recorded, the conversation's telemetry kept the identity of the run that
// created it, so 156 of 1,259 preferred runs carried turns after their own
// recorded completion (11,960 turns) while the runs that actually did the work
// recorded none. The recording now states the move
// (`runtime.session_window.opened` / `.closed`), so a tail is either *explained*
// by the record or a defect.
//
// The alarm is the same shape as the empty-source alarm: a tail the recording
// cannot explain is a build failure, not a note. It is deliberately **per run,
// not per workflow**: a run is recorded iff a session-window row names *its* run
// id. A run with no record of its own is either one that began before its
// workflow started recording (counted, never failed) or a broken record — a run
// that started after the workflow's first session-window event and still has
// none of its own — which fails the build like an unexplained tail does.
//
// A binding alone is not a continuation: the record explains the tail only when
// it names a run the session moved to (`closed`, `attributed`), or when the
// run's own conversation was bound to it at or after that completion (`opened`,
// `resumed` — an abort and a resume, an adoption, or a re-ensure). A session
// that went on under a later run *without* such a record (a handover across a
// host lifetime, where the next binding cannot name the run it left) keeps only
// a binding from before its completion, and that is `unexplained` — the defect
// this alarm exists to refuse.

import { Database } from "bun:sqlite";
import { assertDatasetSchemaVersion } from "./dataset.ts";
import { RUN_WINDOW_DRIFT_SQL } from "./queries.ts";

/** Why a drifting run's tail is what it is. */
export type DriftKind =
	/** The recording states this run's session was rebound to a later run
	 * (`closed`): the tail is a continuation, and the later run did the work. */
	| "attributed"
	/** The recording states the run kept its own conversation after its completion:
	 * an `opened` row at or after it, or the `resumed` reason (an abort and a
	 * resume). The tail is the same run working on the same session. */
	| "resumed"
	/** The run's own window cannot be read (`completed_at <= started_at`): the
	 * traces reader dates an `agent.handoff` span by its start (design D5). */
	| "clock-artifact"
	/** Neither: the turns after the run's completion are attributed to a run whose
	 * recording does not state that the session continued. */
	| "unexplained";

/** One row of the run-window query, exactly as `run-window-drift` reports it. */
export interface RunWindowDriftRow {
	readonly run_id: string;
	readonly workflow_id: string | null;
	readonly role: string;
	readonly status: string;
	readonly run_started_at: string | null;
	readonly run_completed_at: string | null;
	readonly turns: number;
	readonly tail_turns: number;
	readonly first_turn_at: string | null;
	readonly last_turn_at: string | null;
	readonly tail_seconds: number;
	/** `1` iff a session-window row names this run id. */
	readonly session_recorded: number;
	/** The run's own binding reason (`created`/`rebound`/`adopted`/`resumed`), from
	 * its latest `opened` row, or null when the run recorded none. */
	readonly session_reason: string | null;
	/** The run a `closed` record moved the session to, from its latest one. */
	readonly session_rebound_to: string | null;
	/** `1` iff one of the run's own `opened` rows falls at or after its completion:
	 * the record states the session was bound to this run again after it closed. */
	readonly session_opened_after_completion: number;
	/** The first session-window instant of the run's workflow, or null when the
	 * workflow never recorded one. */
	readonly first_session_window_at: string | null;
	readonly drift_kind: DriftKind;
}

/** The runs whose own recording explains their tail: a `closed` naming the run the
 * session moved to, or an `opened` that states the run kept working after its own
 * completion. */
export interface JudgedRunWindow {
	readonly rows: readonly RunWindowDriftRow[];
	/** The session was rebound to a later run (`closed`). */
	readonly attributed: number;
	/** The run's own conversation was bound to it after its completion (`opened`). */
	readonly resumed: number;
}

/** The runs no record explains, split by whether one was due. */
export interface UnrecordedRunWindow {
	readonly rows: readonly RunWindowDriftRow[];
	/** No record is due: the run predates its workflow's first session-window
	 * event, or its own window cannot be read at all. Reported, never failed. */
	readonly beforeRecord: number;
	/** The run started after the workflow already recorded a session window and
	 * its own recording still does not state a continuation: a broken record. */
	readonly afterRecord: number;
}

export interface RunWindowReport {
	/** Every drifting run the query reports. */
	readonly rows: readonly RunWindowDriftRow[];
	/** The rows a session-window record names *and* explains. */
	readonly judged: JudgedRunWindow;
	/** The rows it does not cover: a tail no record states a continuation for. */
	readonly unrecorded: UnrecordedRunWindow;
	/** How many rows are `unexplained` (the unrecorded rows). */
	readonly unexplained: number;
	/** Every row whose own window cannot be read (`completed_at <= started_at`,
	 * design D5), recorded or not. */
	readonly clockArtifact: number;
	/** The rows that fail the build: an unexplained run whose record was due. */
	readonly failures: readonly RunWindowDriftRow[];
	/** Workflow ids whose recording carries at least one session-window event. */
	readonly recordedWorkflows: readonly string[];
}

/** Open a dataset read-only, refusing a file another build wrote: the views these
 * statements read carry columns such a file does not have, and a bare "no such
 * column" would hide the one fix that works. */
function openDataset(datasetPath: string): Database {
	const db = new Database(datasetPath, { readonly: true });
	try {
		assertDatasetSchemaVersion(db, datasetPath);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

/** The workflows whose own recording states a session window. */
function recordedWorkflows(datasetPath: string): string[] {
	const db = openDataset(datasetPath);
	try {
		return db
			.query<{ workflow_id: string }, []>(
				`SELECT DISTINCT workflow_id FROM v_events
				 WHERE workflow_id IS NOT NULL
					AND event LIKE 'runtime.session_window.%'`,
			)
			.all()
			.map((row) => row.workflow_id);
	} finally {
		db.close();
	}
}

/** Whether this run's missing explanation is a defect: it started after its
 * workflow had already recorded a session window, so the record should have named
 * it. An unreadable window is never judged — there is nothing to compare a tail
 * to. */
function recordWasDue(row: RunWindowDriftRow): boolean {
	if (row.drift_kind === "clock-artifact") return false;
	if (row.first_session_window_at === null || row.run_started_at === null)
		return false;
	return (
		Date.parse(row.run_started_at) >= Date.parse(row.first_session_window_at)
	);
}

/**
 * Run the shared run-window statement against a dataset and split its rows by
 * what the recording explains. Uses the statement `run-window-drift` registers
 * (`RUN_WINDOW_DRIFT_SQL`), so the alarm and the query can never disagree about
 * what a tail is.
 */
export function inspectRunWindow(datasetPath: string): RunWindowReport {
	const recorded = recordedWorkflows(datasetPath);
	const db = openDataset(datasetPath);
	let rows: RunWindowDriftRow[];
	try {
		rows = db.query<RunWindowDriftRow, []>(RUN_WINDOW_DRIFT_SQL).all();
	} finally {
		db.close();
	}
	// Three populations, and every row sits in exactly one of them: the record
	// explains it, its window cannot be read at all, or nothing in the record
	// states that the session continued.
	const explained = rows.filter(
		(row) => row.drift_kind === "attributed" || row.drift_kind === "resumed",
	);
	const unrecorded = rows.filter((row) => row.drift_kind === "unexplained");
	const kind = (k: DriftKind): number =>
		rows.filter((row) => row.drift_kind === k).length;
	const due = unrecorded.filter(recordWasDue);
	return {
		rows,
		judged: {
			rows: explained,
			attributed: kind("attributed"),
			resumed: kind("resumed"),
		},
		unrecorded: {
			rows: unrecorded,
			beforeRecord: unrecorded.length - due.length,
			afterRecord: due.length,
		},
		unexplained: unrecorded.length,
		clockArtifact: kind("clock-artifact"),
		failures: due,
		recordedWorkflows: recorded.sort(),
	};
}

/** The build's error message: which runs drift with no record of their own, and
 * how to inspect them. */
export function describeUnexplainedRunWindow(
	failures: readonly RunWindowDriftRow[],
	datasetPath: string,
): string {
	const lines = [
		`error: ${failures.length} run${failures.length === 1 ? "" : "s"} drift${failures.length === 1 ? "s" : ""} past its own recorded window with no session-window record of its own, although the workflow had already recorded one — a run whose session went on under another run must say so (\`runtime.session_window.closed\`), and a run that reuses a conversation must record its own binding (\`runtime.session_window.opened\`), or its status, duration and cost are wrong. The dataset build stops here and writes no dataset.`,
		"",
		...failures.map(
			(row) =>
				`  run ${row.run_id}  (workflow ${row.workflow_id ?? "(unset)"}, role ${row.role}, status ${row.status})  ` +
				`tail ${row.tail_seconds}s over ${row.tail_turns} of ${row.turns} turn(s)  ` +
				`completed ${row.run_completed_at ?? "(unset)"}, last turn ${row.last_turn_at ?? "(unset)"}, ` +
				`started ${row.run_started_at ?? "(unset)"} after the workflow's first record at ${row.first_session_window_at ?? "(unset)"}`,
		),
		"",
		"`bun run scripts/efficiency/analyze.ts run-window-drift --dataset <dir>` lists every drifting run with its `drift_kind` and `session_reason`:",
		"  attributed      the recording states the run's session was rebound to a later run (`closed`)",
		"  resumed         the recording binds the run's own conversation to it at or after its completion, or states `resumed`",
		"  clock-artifact  the recorded completion is not after the start, so the window cannot be read",
		"  unexplained     no record states a continuation — the defect the build refuses when one was due",
		"",
		`The dataset written to ${datasetPath} was removed. A run that predates its workflow's first session-window event, or whose window cannot be read, is reported as unrecorded instead of failing the build.`,
	];
	return `${lines.join("\n")}\n`;
}
