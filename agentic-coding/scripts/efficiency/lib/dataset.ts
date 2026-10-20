// Writing the normalized dataset.
//
// One SQLite file plus a schema README, in an OUT directory outside the
// repository. The file is the analysis surface for every later step: plain
// tables, documented views, and no raw transcript text.

import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
	type EventRow,
	type ExtractedTables,
	SOURCE_LIST,
	type SourceId,
	sourceRank,
	type ToolCallRow,
	type TurnRow,
} from "./types.ts";

// 2: `tool_calls` gained `failure_kind` and `recording` (the telemetry shape
// the runtime records since tool-call telemetry stopped being name-only). A
// dataset built from an older-only snapshot simply carries NULL/legacy values
// in the new columns, so old rows stay readable.
// 3: `events` gained `repair_effects`, `repair_runs` and `wait_kind` (efficiency
// backlog items 11 and 12): what a recorded repair retired, and which kind of
// developer wait a recorded `workflow.waiting` row reports. Append-only, same
// rule: a dataset built from an older-only snapshot carries NULL there.
// 4: `events` gained the session window's own vocabulary (efficiency backlog item
// 20): `session_reason`, `session_rebound_to`, `session_previous_run_id` and
// `session_conversation_id`. Append-only within a version: a v4 dataset built
// from an older-only snapshot carries NULL there. A *file* an older build wrote
// has no such column at all, so reading it is refused
// (`assertDatasetSchemaVersion`) instead of failing with a bare SQL error.
export const DATASET_SCHEMA_VERSION = 4;
export const DATASET_FILE = "dataset.sqlite";

/** A dataset file written by a different build: its `events` table has no column
 * this build's views read. */
export class DatasetSchemaError extends Error {}

/** Refuse a dataset file this build cannot read, naming the rebuild instead of
 * letting a query die on `no such column`. `writeDataset` always writes the
 * current version and deletes an existing file first, so the fix is always a
 * rebuild, never a conversion. */
export function assertDatasetSchemaVersion(
	db: Database,
	datasetPath: string,
): void {
	let built: number | undefined;
	try {
		const row = db
			.query<{ value: string }, []>(
				"SELECT value FROM meta WHERE key = 'datasetSchemaVersion'",
			)
			.get();
		built = row === null ? undefined : Number(row.value);
	} catch {
		// No `meta` table at all: not a dataset this tooling wrote.
		built = undefined;
	}
	if (built === DATASET_SCHEMA_VERSION) return;
	throw new DatasetSchemaError(
		`dataset schema ${built ?? "unknown"} at ${datasetPath}; this build reads ${DATASET_SCHEMA_VERSION} — rebuild it with scripts/efficiency/build-dataset.ts`,
	);
}

/** When the dataset was built, and under which schema version. `analyze` prints
 * it: the version only changes when the file's *shape* changes, so a change in
 * what an existing column means (a normalizer that starts recording an outcome
 * it used to drop) leaves an older file readable and its zeros indistinguishable
 * from measurements. The build date is what tells a reader to rebuild. */
export function datasetMeta(db: Database): {
	builtAt?: string;
	schemaVersion?: number;
} {
	const read = (key: string): string | undefined => {
		try {
			const row = db
				.query<{ value: string }, [string]>(
					"SELECT value FROM meta WHERE key = ?",
				)
				.get(key);
			return row === null ? undefined : row.value;
		} catch {
			return undefined;
		}
	};
	const builtAt = read("builtAt");
	const schemaVersion = read("datasetSchemaVersion");
	return {
		...(builtAt === undefined ? {} : { builtAt }),
		...(schemaVersion === undefined
			? {}
			: { schemaVersion: Number(schemaVersion) }),
	};
}

const TABLES_DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE sources (
	source TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	rank INTEGER NOT NULL,
	description TEXT NOT NULL
);

CREATE TABLE source_files (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	source TEXT NOT NULL,
	path TEXT NOT NULL,
	kind TEXT NOT NULL,
	records INTEGER NOT NULL DEFAULT 0,
	parsed INTEGER NOT NULL DEFAULT 0,
	skipped INTEGER NOT NULL DEFAULT 0,
	note TEXT
);
CREATE INDEX idx_source_files_source ON source_files(source);

CREATE TABLE workflows (
	id TEXT PRIMARY KEY,
	repo TEXT,
	type TEXT,
	definition_id TEXT,
	workflow_type TEXT,
	branch TEXT,
	base_commit TEXT,
	first_at TEXT,
	last_at TEXT,
	status TEXT,
	current_step TEXT,
	sources TEXT NOT NULL,
	source TEXT NOT NULL,
	source_rank INTEGER NOT NULL,
	confidence TEXT NOT NULL
);

CREATE TABLE runs (
	run_id TEXT PRIMARY KEY,
	run_label TEXT,
	workflow_id TEXT,
	step_id TEXT,
	role TEXT,
	profile TEXT,
	model TEXT,
	provider TEXT,
	attempt INTEGER,
	generation INTEGER,
	status TEXT,
	started_at TEXT,
	completed_at TEXT,
	duration_ms INTEGER,
	handoff_outcome TEXT,
	handoff_reason TEXT,
	source TEXT NOT NULL,
	source_rank INTEGER NOT NULL,
	sources TEXT NOT NULL,
	confidence TEXT NOT NULL,
	preferred INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_runs_workflow ON runs(workflow_id);
CREATE INDEX idx_runs_role ON runs(role);

CREATE TABLE turns (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	run_label TEXT,
	workflow_id TEXT,
	source TEXT NOT NULL,
	source_rank INTEGER NOT NULL,
	turn_index INTEGER NOT NULL,
	started_at TEXT,
	ended_at TEXT,
	duration_ms INTEGER,
	input_tokens INTEGER,
	output_tokens INTEGER,
	cache_read_tokens INTEGER,
	cache_write_tokens INTEGER,
	total_tokens INTEGER,
	cost REAL,
	thinking_tokens INTEGER,
	stop_reason TEXT,
	tool_calls INTEGER,
	model TEXT,
	provider TEXT,
	confidence TEXT NOT NULL,
	preferred INTEGER NOT NULL DEFAULT 0,
	UNIQUE (run_id, source, turn_index)
);
CREATE INDEX idx_turns_run ON turns(run_id);
CREATE INDEX idx_turns_workflow ON turns(workflow_id);

CREATE TABLE tool_calls (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	run_label TEXT,
	workflow_id TEXT,
	source TEXT NOT NULL,
	source_rank INTEGER NOT NULL,
	turn_index INTEGER,
	call_id TEXT,
	dedupe_key TEXT NOT NULL,
	tool TEXT NOT NULL,
	started_at TEXT,
	ended_at TEXT,
	duration_ms INTEGER,
	ok INTEGER,
	error_class TEXT,
	failure_kind TEXT,
	args_hash TEXT,
	args_digest TEXT,
	args_bytes INTEGER,
	result_bytes INTEGER,
	result_lines INTEGER,
	result_truncated INTEGER,
	recording TEXT NOT NULL,
	confidence TEXT NOT NULL,
	preferred INTEGER NOT NULL DEFAULT 0,
	UNIQUE (run_id, source, dedupe_key)
);
CREATE INDEX idx_tool_calls_run ON tool_calls(run_id);
CREATE INDEX idx_tool_calls_workflow ON tool_calls(workflow_id);
CREATE INDEX idx_tool_calls_tool ON tool_calls(tool);
CREATE INDEX idx_tool_calls_hash ON tool_calls(args_hash);
CREATE INDEX idx_tool_calls_failure ON tool_calls(failure_kind);

CREATE TABLE events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	workflow_id TEXT,
	run_id TEXT,
	run_label TEXT,
	source TEXT NOT NULL,
	source_rank INTEGER NOT NULL,
	at TEXT,
	event TEXT NOT NULL,
	event_class TEXT NOT NULL,
	step_id TEXT,
	role TEXT,
	outcome TEXT,
	error_class TEXT,
	severity TEXT,
	count INTEGER NOT NULL DEFAULT 1,
	trace_id TEXT,
	-- The compaction generation's own vocabulary (efficiency backlog item 6): which
	-- kind ran and whether it blocked the request. Append-only: an older dataset
	-- simply has the columns empty.
	compaction_kind TEXT,
	compaction_blocking INTEGER,
	-- The repair and waiting vocabulary (efficiency backlog items 11 and 12): what
	-- a recorded repair expired and retired, and which kind of developer wait a
	-- workflow.waiting row reports. Append-only, like every column above.
	repair_effects INTEGER,
	repair_runs INTEGER,
	repair_count INTEGER,
	wait_kind TEXT,
	-- The session-window vocabulary (efficiency backlog item 20): the reason a
	-- conversation was bound to a run (created, rebound, adopted, resumed), the
	-- run it left and the run it moved to, and the conversation the window
	-- belongs to. Append-only since schema 4: a v4 dataset built from an
	-- older-only snapshot has them empty, and a dataset file an earlier build
	-- wrote must be rebuilt (see assertDatasetSchemaVersion).
	session_reason TEXT,
	session_rebound_to TEXT,
	session_previous_run_id TEXT,
	session_conversation_id TEXT,
	detail TEXT,
	detail_hash TEXT,
	detail_bytes INTEGER,
	confidence TEXT NOT NULL,
	preferred INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_events_workflow ON events(workflow_id);
CREATE INDEX idx_events_event ON events(event);
CREATE INDEX idx_events_run ON events(run_id);
`;

const VIEWS_DDL = `
-- Preferred rows only: the de-duplicated view. Every loser stays in the base
-- table so a reconciliation check can still compare the sources.
CREATE VIEW v_runs AS SELECT * FROM runs WHERE preferred = 1;
CREATE VIEW v_turns AS SELECT * FROM turns WHERE preferred = 1;
CREATE VIEW v_tool_calls AS SELECT * FROM tool_calls WHERE preferred = 1;
CREATE VIEW v_events AS SELECT * FROM events WHERE preferred = 1;

CREATE VIEW v_run_summary AS
SELECT
	r.run_id,
	r.workflow_id,
	r.run_label,
	r.role,
	r.step_id,
	r.profile,
	r.model,
	r.status,
	r.started_at,
	r.completed_at,
	r.duration_ms,
	r.confidence,
	r.sources,
	(SELECT COUNT(*) FROM v_turns t WHERE t.run_id = r.run_id) AS turns,
	(SELECT COUNT(*) FROM v_tool_calls c WHERE c.run_id = r.run_id) AS tool_calls,
	(SELECT COUNT(*) FROM v_tool_calls c WHERE c.run_id = r.run_id AND c.ok = 0) AS failed_calls,
	(SELECT COALESCE(SUM(c.result_bytes), 0) FROM v_tool_calls c WHERE c.run_id = r.run_id) AS result_bytes,
	(SELECT COALESCE(SUM(c.args_bytes), 0) FROM v_tool_calls c WHERE c.run_id = r.run_id) AS args_bytes,
	(SELECT SUM(t.input_tokens) FROM v_turns t WHERE t.run_id = r.run_id) AS input_tokens,
	(SELECT SUM(t.output_tokens) FROM v_turns t WHERE t.run_id = r.run_id) AS output_tokens,
	(SELECT SUM(t.cache_read_tokens) FROM v_turns t WHERE t.run_id = r.run_id) AS cache_read_tokens,
	(SELECT SUM(t.cache_write_tokens) FROM v_turns t WHERE t.run_id = r.run_id) AS cache_write_tokens,
	(SELECT SUM(t.cost) FROM v_turns t WHERE t.run_id = r.run_id) AS cost,
	(SELECT MAX(t.input_tokens) FROM v_turns t WHERE t.run_id = r.run_id) AS peak_input_tokens
FROM v_runs r;

CREATE VIEW v_workflow_summary AS
SELECT
	w.id,
	w.repo,
	w.definition_id,
	w.branch,
	w.status,
	w.first_at,
	w.last_at,
	w.sources,
	w.confidence,
	(SELECT COUNT(*) FROM v_runs r WHERE r.workflow_id = w.id) AS runs,
	(SELECT COUNT(*) FROM v_turns t WHERE t.workflow_id = w.id) AS turns,
	(SELECT COUNT(*) FROM v_tool_calls c WHERE c.workflow_id = w.id) AS tool_calls,
	(SELECT SUM(t.input_tokens) FROM v_turns t WHERE t.workflow_id = w.id) AS input_tokens,
	(SELECT SUM(t.output_tokens) FROM v_turns t WHERE t.workflow_id = w.id) AS output_tokens,
	(SELECT SUM(t.cost) FROM v_turns t WHERE t.workflow_id = w.id) AS cost
FROM workflows w;

-- The coverage matrix: what each workflow can and cannot be analysed from.
CREATE VIEW v_workflow_coverage AS
SELECT
	w.id,
	w.repo,
	w.definition_id,
	w.first_at,
	w.last_at,
	w.sources,
	w.confidence,
	(SELECT COUNT(*) FROM runs r WHERE r.workflow_id = w.id) AS runs,
	instr(w.sources, 'harness.') > 0 AS has_harness_source,
	instr(w.sources, 'traces.') > 0 AS has_spans,
	instr(w.sources, 'herdr.') > 0 AS has_durable_store,
	EXISTS(SELECT 1 FROM turns t WHERE t.workflow_id = w.id AND t.source LIKE 'harness%') AS has_transcript,
	EXISTS(SELECT 1 FROM turns t WHERE t.workflow_id = w.id) AS has_turns,
	EXISTS(
		SELECT 1 FROM turns t
		WHERE t.workflow_id = w.id
			AND (t.input_tokens IS NOT NULL OR t.total_tokens IS NOT NULL OR t.cost IS NOT NULL)
	) AS has_usage,
	EXISTS(
		SELECT 1 FROM turns t
		WHERE t.workflow_id = w.id AND t.stop_reason IS NOT NULL
	) AS has_stop_reason,
	EXISTS(
		SELECT 1 FROM turns t
		WHERE t.workflow_id = w.id AND t.thinking_tokens IS NOT NULL
	) AS has_thinking,
	EXISTS(SELECT 1 FROM tool_calls c WHERE c.workflow_id = w.id) AS has_tool_calls,
	EXISTS(
		SELECT 1 FROM tool_calls c
		WHERE c.workflow_id = w.id AND c.args_hash IS NOT NULL
	) AS has_tool_args,
	EXISTS(
		SELECT 1 FROM tool_calls c
		WHERE c.workflow_id = w.id AND c.result_bytes IS NOT NULL
	) AS has_result_sizes,
	EXISTS(
		SELECT 1 FROM tool_calls c
		WHERE c.workflow_id = w.id AND c.duration_ms IS NOT NULL
	) AS has_call_durations,
	EXISTS(
		SELECT 1 FROM tool_calls c
		WHERE c.workflow_id = w.id AND c.failure_kind IS NOT NULL
	) AS has_failure_kinds,
	EXISTS(
		SELECT 1 FROM events e WHERE e.workflow_id = w.id AND e.event_class = 'verifier'
	) AS has_verifier_events,
	EXISTS(
		SELECT 1 FROM events e WHERE e.workflow_id = w.id AND e.event_class = 'gate'
	) AS has_gate_events,
	EXISTS(
		SELECT 1 FROM events e WHERE e.workflow_id = w.id AND e.event_class = 'compaction'
	) AS has_compaction_events
FROM workflows w;

CREATE VIEW v_harness_sources AS
SELECT DISTINCT source FROM source_files WHERE kind = 'harness';
`;

function tableCount(db: Database, table: string): number {
	const row = db
		.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`)
		.get();
	return row?.n ?? 0;
}

interface Markable {
	source: SourceId;
	preferred: number;
}

/** Mark the winner of each duplicate group. Grouping is the documented
 * de-duplication key: a run id for runs/turns/calls, and workflow + run +
 * event + second for the event log. */
function markPreferred<T extends Markable>(
	rows: T[],
	key: (row: T) => string,
): void {
	const best = new Map<string, number>();
	for (const row of rows) {
		const group = key(row);
		const rank = sourceRank(row.source);
		const current = best.get(group);
		if (current === undefined || rank > current) best.set(group, rank);
	}
	for (const row of rows)
		row.preferred = sourceRank(row.source) === best.get(key(row)) ? 1 : 0;
}

export function applyPreferred(tables: ExtractedTables): void {
	markPreferred(tables.runs, (row) => row.run_id);
	markPreferred(tables.turns, (row) => row.run_id);
	markPreferred(tables.toolCalls, (row) => row.run_id);
	markPreferred(
		tables.events,
		(row) =>
			`${row.workflow_id ?? ""}|${row.run_id ?? ""}|${row.event}|${(row.at ?? "").slice(0, 19)}|${row.step_id ?? ""}`,
	);
}

export interface WriteDatasetResult {
	path: string;
	counts: Record<string, number>;
	bytes: number;
}

export interface WriteDatasetOptions {
	outDir: string;
	tables: ExtractedTables;
	meta: Record<string, string>;
}

function insertAll(
	db: Database,
	tables: ExtractedTables,
	meta: Record<string, string>,
): void {
	const sourceStatement = db.prepare(
		"INSERT INTO sources (source, kind, rank, description) VALUES (?, ?, ?, ?)",
	);
	const metaStatement = db.prepare(
		"INSERT INTO meta (key, value) VALUES (?, ?)",
	);
	const sourceFileStatement = db.prepare(
		"INSERT INTO source_files (source, path, kind, records, parsed, skipped, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const workflowStatement = db.prepare(
		`INSERT INTO workflows (id, repo, type, definition_id, workflow_type, branch, base_commit, first_at, last_at, status, current_step, sources, source, source_rank, confidence)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const runStatement = db.prepare(
		`INSERT INTO runs (run_id, run_label, workflow_id, step_id, role, profile, model, provider, attempt, generation, status, started_at, completed_at, duration_ms, handoff_outcome, handoff_reason, source, source_rank, sources, confidence, preferred)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const turnStatement = db.prepare(
		`INSERT OR REPLACE INTO turns (run_id, run_label, workflow_id, source, source_rank, turn_index, started_at, ended_at, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, thinking_tokens, stop_reason, tool_calls, model, provider, confidence, preferred)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const toolStatement = db.prepare(
		`INSERT OR REPLACE INTO tool_calls (run_id, run_label, workflow_id, source, source_rank, turn_index, call_id, dedupe_key, tool, started_at, ended_at, duration_ms, ok, error_class, failure_kind, args_hash, args_digest, args_bytes, result_bytes, result_lines, result_truncated, recording, confidence, preferred)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const eventStatement = db.prepare(
		`INSERT INTO events (workflow_id, run_id, run_label, source, source_rank, at, event, event_class, step_id, role, outcome, error_class, severity, count, trace_id, compaction_kind, compaction_blocking, repair_effects, repair_runs, repair_count, wait_kind, session_reason, session_rebound_to, session_previous_run_id, session_conversation_id, detail, detail_hash, detail_bytes, confidence, preferred)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	for (const descriptor of SOURCE_LIST)
		sourceStatement.run(
			descriptor.source,
			descriptor.kind,
			descriptor.rank,
			descriptor.description,
		);

	for (const file of tables.sourceFiles)
		sourceFileStatement.run(
			file.source,
			file.path,
			file.kind,
			file.records,
			file.parsed,
			file.skipped,
			file.note ?? null,
		);
	for (const workflow of tables.workflows)
		workflowStatement.run(
			workflow.id,
			workflow.repo,
			workflow.type,
			workflow.definition_id,
			workflow.workflow_type,
			workflow.branch,
			workflow.base_commit,
			workflow.first_at,
			workflow.last_at,
			workflow.status,
			workflow.current_step,
			workflow.sources,
			workflow.source,
			workflow.source_rank,
			workflow.confidence,
		);
	for (const run of tables.runs)
		runStatement.run(
			run.run_id,
			run.run_label,
			run.workflow_id,
			run.step_id,
			run.role,
			run.profile,
			run.model,
			run.provider,
			run.attempt,
			run.generation,
			run.status,
			run.started_at,
			run.completed_at,
			run.duration_ms,
			run.handoff_outcome,
			run.handoff_reason,
			run.source,
			run.source_rank,
			run.sources,
			run.confidence,
			run.preferred,
		);
	for (const turn of tables.turns)
		turnStatement.run(
			turn.run_id,
			turn.run_label,
			turn.workflow_id,
			turn.source,
			turn.source_rank,
			turn.turn_index,
			turn.started_at,
			turn.ended_at,
			turn.duration_ms,
			turn.input_tokens,
			turn.output_tokens,
			turn.cache_read_tokens,
			turn.cache_write_tokens,
			turn.total_tokens,
			turn.cost,
			turn.thinking_tokens,
			turn.stop_reason,
			turn.tool_calls,
			turn.model,
			turn.provider,
			turn.confidence,
			turn.preferred,
		);
	for (const call of tables.toolCalls)
		toolStatement.run(
			call.run_id,
			call.run_label,
			call.workflow_id,
			call.source,
			call.source_rank,
			call.turn_index,
			call.call_id,
			call.dedupe_key,
			call.tool,
			call.started_at,
			call.ended_at,
			call.duration_ms,
			call.ok,
			call.error_class,
			call.failure_kind,
			call.args_hash,
			call.args_digest,
			call.args_bytes,
			call.result_bytes,
			call.result_lines,
			call.result_truncated,
			call.recording,
			call.confidence,
			call.preferred,
		);
	for (const event of tables.events)
		eventStatement.run(
			event.workflow_id,
			event.run_id,
			event.run_label,
			event.source,
			event.source_rank,
			event.at,
			event.event,
			event.event_class,
			event.step_id,
			event.role,
			event.outcome,
			event.error_class,
			event.severity,
			event.count,
			event.trace_id,
			event.compaction_kind,
			event.compaction_blocking,
			event.repair_effects,
			event.repair_runs,
			event.repair_count,
			event.wait_kind,
			event.session_reason,
			event.session_rebound_to,
			event.session_previous_run_id,
			event.session_conversation_id,
			event.detail,
			event.detail_hash,
			event.detail_bytes,
			event.confidence,
			event.preferred,
		);
	for (const [key, value] of Object.entries(meta))
		metaStatement.run(key, value);
	metaStatement.run("datasetSchemaVersion", String(DATASET_SCHEMA_VERSION));
}

export function writeDataset(options: WriteDatasetOptions): WriteDatasetResult {
	applyPreferred(options.tables);
	fs.mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
	const dbPath = path.join(options.outDir, DATASET_FILE);
	for (const suffix of ["", "-wal", "-shm"])
		fs.rmSync(`${dbPath}${suffix}`, { force: true });
	const db = new Database(dbPath, { create: true });
	try {
		db.exec("PRAGMA journal_mode = DELETE");
		db.exec(TABLES_DDL);
		db.transaction(() => insertAll(db, options.tables, options.meta))();
		db.exec(VIEWS_DDL);
	} finally {
		db.close();
	}
	const counts: Record<string, number> = {};
	const db2 = new Database(dbPath, { readonly: true });
	try {
		for (const table of [
			"meta",
			"sources",
			"source_files",
			"workflows",
			"runs",
			"turns",
			"tool_calls",
			"events",
		])
			counts[table] = tableCount(db2, table);
	} finally {
		db2.close();
	}
	fs.chmodSync(options.outDir, 0o700);
	fs.chmodSync(dbPath, 0o600);
	return {
		path: dbPath,
		counts,
		bytes: fs.statSync(dbPath).size,
	};
}

export interface DatasetCounts {
	workflows: number;
	runs: number;
	turns: number;
	toolCalls: number;
	events: number;
}

export function readCounts(dbPath: string): DatasetCounts {
	const db = new Database(dbPath, { readonly: true });
	try {
		return {
			workflows: tableCount(db, "workflows"),
			runs: tableCount(db, "runs"),
			turns: tableCount(db, "turns"),
			toolCalls: tableCount(db, "tool_calls"),
			events: tableCount(db, "events"),
		};
	} finally {
		db.close();
	}
}

/** Row types re-exported for the analysis helpers. */
export type { EventRow, ToolCallRow, TurnRow };
