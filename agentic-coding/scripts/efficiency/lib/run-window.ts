// The dataset build's run-window alarm (efficiency backlog item 20: a run's
// window is its session's window).
//
// A run's window is the engine's — `started_at` to the `agent.handoff` that
// closed it — and a session outlives the run: one pi-durable conversation serves
// every later run of the same step and role. Before the session window was
// recorded, the conversation's telemetry kept the identity of the run that
// created it, so 156 of 1,259 preferred runs carried turns after their own
// recorded completion (11,960 of 34,711 turns) while the runs that actually did
// the work recorded none. The recording now states the move
// (`runtime.session_window.opened` / `.closed`), so a tail is either *explained*
// by the record or a defect.
//
// The alarm is the same shape as the empty-source alarm: an unexplained tail is
// a build failure, not a note. It is deliberately **per workflow**: only a
// workflow whose own recording states a session window is judged at all, so a
// generation that predates the record (the whole pinned snapshot) is reported as
// `unrecorded` and never fails a build.

import { Database } from "bun:sqlite";
import { RUN_WINDOW_DRIFT_SQL } from "./queries.ts";

/** Why a drifting run's tail is what it is. */
export type DriftKind =
	/** The recording states this run's session was rebound to a later run: the
	 * tail is a continuation, and the later run is the one that did the work. */
	| "attributed"
	/** The run's own window cannot be read (`completed_at <= started_at`): the
	 * traces reader dates an `agent.handoff` span by its start (design D5). */
	| "clock-artifact"
	/** Neither: the turns after the run's completion are attributed to a run that
	 * recorded nothing about continuing. */
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
	readonly drift_kind: DriftKind;
}

export interface RunWindowReport {
	/** Every drifting run the query reports. */
	readonly rows: readonly RunWindowDriftRow[];
	/** The rows the alarm judges: those whose workflow recorded a session window. */
	readonly judged: readonly RunWindowDriftRow[];
	/** The rows it cannot judge, because their workflow's recording predates the
	 * session window. Reported, never failed. */
	readonly unrecorded: readonly RunWindowDriftRow[];
	/** Drifting runs per class, over every row. */
	readonly attributed: number;
	readonly clockArtifact: number;
	readonly unexplained: number;
	/** The rows that fail the build: an unexplained tail in a judged workflow. */
	readonly failures: readonly RunWindowDriftRow[];
	/** Workflow ids whose recording carries at least one session-window event. */
	readonly recordedWorkflows: readonly string[];
}

/** The workflows whose own recording states a session window. */
function recordedWorkflows(datasetPath: string): string[] {
	const db = new Database(datasetPath, { readonly: true });
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

/**
 * Run the shared run-window statement against a dataset and split its rows by
 * what the recording explains. Uses the statement `run-window-drift` registers
 * (`RUN_WINDOW_DRIFT_SQL`), so the alarm and the query can never disagree about
 * what a tail is.
 */
export function inspectRunWindow(datasetPath: string): RunWindowReport {
	const recorded = recordedWorkflows(datasetPath);
	const recordedSet = new Set(recorded);
	const db = new Database(datasetPath, { readonly: true });
	let rows: RunWindowDriftRow[];
	try {
		rows = db.query<RunWindowDriftRow, []>(RUN_WINDOW_DRIFT_SQL).all();
	} finally {
		db.close();
	}
	const judged = rows.filter(
		(row) => row.workflow_id !== null && recordedSet.has(row.workflow_id),
	);
	const count = (kind: DriftKind): number =>
		rows.filter((row) => row.drift_kind === kind).length;
	return {
		rows,
		judged,
		unrecorded: rows.filter(
			(row) => row.workflow_id === null || !recordedSet.has(row.workflow_id),
		),
		attributed: count("attributed"),
		clockArtifact: count("clock-artifact"),
		unexplained: count("unexplained"),
		failures: judged.filter((row) => row.drift_kind === "unexplained"),
		recordedWorkflows: recorded.sort(),
	};
}

/** The build's error message: which runs carry an unexplained tail, and how to
 * inspect them. */
export function describeUnrecordedRunWindow(
	failures: readonly RunWindowDriftRow[],
	datasetPath: string,
): string {
	const lines = [
		`error: ${failures.length} run${failures.length === 1 ? "" : "s"} carr${failures.length === 1 ? "ies" : "y"} turns after its own recorded completion with nothing in the recording that explains them — a run whose session went on under another run must say so (\`runtime.session_window.closed\`), or its status, duration and cost are wrong. The dataset build stops here and writes no dataset.`,
		"",
		...failures.map(
			(row) =>
				`  run ${row.run_id}  (workflow ${row.workflow_id ?? "(unset)"}, role ${row.role}, status ${row.status})  ` +
				`tail ${row.tail_seconds}s over ${row.tail_turns} of ${row.turns} turn(s)  ` +
				`completed ${row.run_completed_at ?? "(unset)"}, last turn ${row.last_turn_at ?? "(unset)"}`,
		),
		"",
		"`bun run scripts/efficiency/analyze.ts run-window-drift --dataset <dir>` lists every drifting run with its `drift_kind`:",
		"  attributed      the recording states the run's session was rebound to a later run",
		"  clock-artifact  the recorded completion is not after the start, so the window cannot be read",
		"  unexplained     neither — this is the defect the build refuses",
		"",
		`The dataset written to ${datasetPath} was removed. Only workflows whose own recording carries a \`runtime.session_window.*\` event are judged; a workflow that predates the record is reported as unrecorded.`,
	];
	return `${lines.join("\n")}\n`;
}
