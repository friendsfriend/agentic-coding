import { Database, type Statement } from "bun:sqlite";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type LogData,
	type MetricData,
	RECENT_SPAN_LIMIT,
	type SpanData,
	TRACE_PAGE_SIZE,
	type TraceSummaryPage,
	type TraceSummaryRow,
} from "../contracts/telemetry.ts";
import {
	loadProjectCatalog,
	projectCanonicalRoots,
} from "../workflow/project-catalog.ts";
import {
	jsonlLines,
	parseJsonl,
	parseLine as parseJsonlLine,
	parseTelemetryJsonlFrom,
	parseTelemetryLine,
} from "./telemetry-parser";

interface TraceRow {
	id: number;
	change_id: string;
	span: string;
	ingested_at: string;
}

interface MetricRow {
	id: number;
	change_id: string;
	metric: string;
	ingested_at: string;
}

interface LogRow {
	id: number;
	change_id: string;
	log: string;
	ingested_at: string;
}

const MAX_TRACE_BYTES = 16 * 1024 * 1024;
/** Upper bound a caller may ask for in one trace-list page. */
const MAX_TRACE_LIST_PER_PAGE = 500;

const MAX_TELEMETRY_SPANS = 50_000;
/** Bumped whenever the ingest parser or the persisted watermark changes so
 * existing workspaces re-ingest from the start of their file instead of
 * resuming at an offset the new code did not write. */
const PARSER_VERSION = 4;
/** How often a watched repository is checked for appended bytes. */
const WORKSPACE_WATCH_MS = 2000;
/** Lines parsed between two yields of the event loop. The watcher runs inside
 * the TUI process, so a long appended tail is parsed in bounded chunks. */
const INGEST_CHUNK_LINES = 500;

interface TraceSource {
	path: string;
	/** Parse one window of JSONL lines, continuing the line numbering of the
	 * windows already parsed (`startIndex`); see `parseTelemetryJsonlFrom`. */
	parse: (text: string, startIndex?: number) => SpanData[];
	/** Parse a single line at its 1-based position in the file. */
	parseLine: (line: string, index: number) => SpanData | undefined;
}

/** The bytes already ingested for one workspace file. `ingest_offset` is a byte
 * offset at a line boundary: everything before it was parsed exactly once by
 * this parser version, and only what follows is parsed on the next tick. */
interface WorkspaceFileState {
	path: string;
	file_mtime: number;
	file_size: number;
	ingest_offset: number;
	line_index: number;
	parser_version: number;
}

/** Where one workspace file's ingest starts on this tick, and whether the rows
 * already stored for the workflow have to be dropped first (a full re-ingest). */
interface IngestPlan {
	readonly start: number;
	readonly lineIndex: number;
	readonly reset: boolean;
}

/** Where a window ends in the file, and the line numbering it leaves behind. */
interface IngestWatermark {
	readonly mtime: number;
	readonly size: number;
	readonly offset: number;
	readonly lineIndex: number;
}

/** Pick the span source for a workflow directory. The current engine only
 * appends `telemetry.jsonl`, so a stale legacy `traces.jsonl` must not mask new
 * events: when both exist the fresher file wins (telemetry breaks a tie), and
 * a workspace with only one file uses it. */
function workspaceTraceSource(herdrPath: string): TraceSource | undefined {
	const legacyPath = join(herdrPath, "traces.jsonl");
	const telemetryPath = join(herdrPath, "telemetry.jsonl");
	const legacyExists = existsSync(legacyPath);
	const telemetryExists = existsSync(telemetryPath);
	if (legacyExists && telemetryExists) {
		const legacyMtime = statSync(legacyPath).mtimeMs;
		const telemetryMtime = statSync(telemetryPath).mtimeMs;
		return telemetryMtime >= legacyMtime
			? {
					path: telemetryPath,
					parse: parseTelemetryJsonlFrom,
					parseLine: parseTelemetryLine,
				}
			: { path: legacyPath, parse: parseJsonl, parseLine: parseJsonlLine };
	}
	if (telemetryExists)
		return {
			path: telemetryPath,
			parse: parseTelemetryJsonlFrom,
			parseLine: parseTelemetryLine,
		};
	if (legacyExists)
		return { path: legacyPath, parse: parseJsonl, parseLine: parseJsonlLine };
	return undefined;
}

const NEWLINE_BYTE = 0x0a;

/** A trailing fragment is a complete record only when it parses: an append-only
 * writer may never terminate its last line and a full parse reads it, while a
 * half-written line has to wait for the next tick instead of being consumed. */
function isCompleteRecord(fragment: string): boolean {
	const trimmed = fragment.trim();
	if (!trimmed) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

/** How many bytes of a read window form complete lines: everything up to the
 * last newline, plus a trailing line that is already a complete record. */
function consumedLineBytes(window: Buffer): number {
	if (window.length === 0) return 0;
	const last = window.lastIndexOf(NEWLINE_BYTE);
	if (last === window.length - 1) return window.length;
	if (isCompleteRecord(window.subarray(last + 1).toString("utf8")))
		return window.length;
	return last + 1;
}

/** Read `[start, end)` without loading what precedes it: the point of the
 * watermark is that an append costs the appended bytes, not the whole file. */
function readWindowSync(path: string, start: number, end: number): Buffer {
	const length = Math.max(0, end - start);
	if (length === 0) return Buffer.alloc(0);
	const buffer = Buffer.allocUnsafe(length);
	const fd = openSync(path, "r");
	try {
		let read = 0;
		while (read < length) {
			const chunk = readSync(fd, buffer, read, length - read, start + read);
			if (chunk <= 0) break;
			read += chunk;
		}
		return buffer.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

/** The async read of the same window, so the watcher does not block on I/O. */
async function readWindowAsync(
	path: string,
	start: number,
	end: number,
): Promise<Buffer> {
	const length = Math.max(0, end - start);
	if (length === 0) return Buffer.alloc(0);
	return Buffer.from(await Bun.file(path).slice(start, end).arrayBuffer());
}

/** The aggregated trace-list columns for one ingested span. A malformed span
 * document must not abort a whole workspace ingest, so anything unreadable
 * contributes NULL columns and the row stays visible as raw telemetry. */
function traceColumns(span: unknown): Record<string, string | number | null> {
	const record = span as {
		name?: unknown;
		startTimeUnixNano?: unknown;
		endTimeUnixNano?: unknown;
		status?: { code?: unknown };
		attributes?: unknown;
	};
	const nanos = (value: unknown) =>
		typeof value === "string" && /^\d+$/.test(value) ? value : null;
	let role: string | null = null;
	if (Array.isArray(record?.attributes)) {
		for (const attribute of record.attributes) {
			const entry = attribute as { key?: unknown; value?: unknown };
			if (entry?.key === "herdr.role" && typeof entry.value === "string")
				role = entry.value;
		}
	}
	return {
		$span: JSON.stringify(span),
		$name: typeof record?.name === "string" ? record.name : null,
		$start_nanos: nanos(record?.startTimeUnixNano),
		$end_nanos: nanos(record?.endTimeUnixNano),
		$status_code:
			typeof record?.status?.code === "number" ? record.status.code : null,
		$role: role,
	};
}

/** Decode the trace-list aggregation's JSON array of distinct span names,
 * tolerating the `null` entries JSON aggregation leaves for rows without a
 * name. A JSON array is used instead of a delimiter-joined string because span
 * names are arbitrary strings that may contain any separator. */
function parseSpanNames(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return [
			...new Set(
				parsed.filter((name): name is string => typeof name === "string"),
			),
		];
	} catch {
		return [];
	}
}

export class TraceDb {
	private db: Database;
	private readonly ingesting = new Set<string>();
	private ingestStmt: Statement;
	private ingestMetricStmt: Statement;
	private ingestLogStmt: Statement;
	private upsertWorkspaceStmt: Statement;
	private workspaceStateStmt: Statement;
	private traceCountStmt: Statement;
	private trimTracesStmt: Statement;
	private readonly listeners = new Set<() => void>();
	private readonly watchedRepos = new Map<string, () => void>();

	constructor(dbPath?: string) {
		const dir = dbPath ?? join(homedir(), ".config", "otel-tui");
		mkdirSync(dir, { recursive: true });
		this.db = new Database(join(dir, "traces.sqlite"));
		this.db.run(`CREATE TABLE IF NOT EXISTS traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT NOT NULL,
      span TEXT NOT NULL,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
		this.db.run(
			`CREATE INDEX IF NOT EXISTS idx_traces_change ON traces(change_id)`,
		);
		// Aggregated list columns. The trace list is paged and ordered by start
		// time, which a `json_extract` over every span row cannot do within a
		// request budget, so the fields the aggregation needs are materialized at
		// ingest and indexed. Existing rows are backfilled once below.
		for (const column of [
			"start_nanos INTEGER",
			"end_nanos INTEGER",
			"status_code INTEGER",
			"role TEXT",
			"name TEXT",
		]) {
			try {
				this.db.run(`ALTER TABLE traces ADD COLUMN ${column}`);
			} catch (error) {
				if (!String(error).includes("duplicate column name")) throw error;
			}
		}
		this.db.run(
			`CREATE INDEX IF NOT EXISTS idx_traces_start ON traces(start_nanos)`,
		);
		this.db.run(
			`CREATE INDEX IF NOT EXISTS idx_traces_change_start ON traces(change_id, start_nanos)`,
		);
		this.backfillTraceColumns();
		this.db.run(`CREATE TABLE IF NOT EXISTS workspace_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT UNIQUE NOT NULL,
      path TEXT NOT NULL,
      file_mtime INTEGER NOT NULL DEFAULT 0,
      parser_version INTEGER NOT NULL DEFAULT 1,
      file_size INTEGER NOT NULL DEFAULT 0,
      ingest_offset INTEGER NOT NULL DEFAULT 0,
      line_index INTEGER NOT NULL DEFAULT 0
    )`);
		// The watermark columns arrived after the table did: an existing database
		// gains them here (and re-ingests once, because its rows still carry the
		// old parser version).
		for (const column of [
			"parser_version INTEGER NOT NULL DEFAULT 1",
			"file_size INTEGER NOT NULL DEFAULT 0",
			"ingest_offset INTEGER NOT NULL DEFAULT 0",
			"line_index INTEGER NOT NULL DEFAULT 0",
		]) {
			try {
				this.db.run(`ALTER TABLE workspace_files ADD COLUMN ${column}`);
			} catch (error) {
				if (!String(error).includes("duplicate column name")) throw error;
			}
		}
		this.db.run(`CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
		this.db.run(
			`CREATE INDEX IF NOT EXISTS idx_metrics_change ON metrics(change_id)`,
		);
		this.db.run(`CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT NOT NULL,
      log TEXT NOT NULL,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
		this.db.run(
			`CREATE INDEX IF NOT EXISTS idx_logs_change ON logs(change_id)`,
		);
		this.db.run(
			`CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(json_extract(log, '$.traceId'))`,
		);
		this.ingestStmt = this.db.prepare(
			`INSERT INTO traces (change_id, span, name, start_nanos, end_nanos, status_code, role, ingested_at)
       VALUES ($change_id, $span, $name, $start_nanos, $end_nanos, $status_code, $role, datetime('now'))`,
		);
		this.ingestMetricStmt = this.db.prepare(
			"INSERT INTO metrics (change_id, metric, ingested_at) VALUES ($change_id, $metric, datetime('now'))",
		);
		this.ingestLogStmt = this.db.prepare(
			"INSERT INTO logs (change_id, log, ingested_at) VALUES ($change_id, $log, datetime('now'))",
		);
		this.upsertWorkspaceStmt = this.db.prepare(
			`INSERT INTO workspace_files (change_id, path, file_mtime, parser_version, file_size, ingest_offset, line_index) VALUES ($change_id, $path, $mtime, ${PARSER_VERSION}, $size, $offset, $line_index) ON CONFLICT(change_id) DO UPDATE SET path=$path, file_mtime=$mtime, parser_version=${PARSER_VERSION}, file_size=$size, ingest_offset=$offset, line_index=$line_index`,
		);
		this.workspaceStateStmt = this.db.prepare(
			"SELECT path, file_mtime, file_size, ingest_offset, line_index, parser_version FROM workspace_files WHERE change_id=?",
		);
		this.traceCountStmt = this.db.prepare(
			"SELECT COUNT(*) count FROM traces WHERE change_id=?",
		);
		this.trimTracesStmt = this.db.prepare(
			`DELETE FROM traces WHERE id IN (SELECT id FROM traces WHERE change_id=$change_id ORDER BY id DESC LIMIT -1 OFFSET $keep)`,
		);
	}

	/** The bytes already ingested for a workspace, if this database ingested it
	 * with the current parser version. */
	private workspaceFileState(changeId: string): WorkspaceFileState | undefined {
		return this.workspaceStateStmt.get(changeId) as
			| WorkspaceFileState
			| undefined;
	}

	/** What one workspace file needs on this tick: nothing, the appended tail, or
	 * a full re-ingest. */
	private planIngest(
		source: TraceSource,
		size: number,
		mtime: number,
		known: WorkspaceFileState | undefined,
	): IngestPlan | undefined {
		// A parser upgrade or a source switch (a legacy snapshot versus the
		// workflow's own telemetry) invalidates the stored offsets: both re-ingest
		// from zero instead of resuming at a watermark they did not write.
		if (
			known &&
			known.parser_version >= PARSER_VERSION &&
			known.path === source.path
		) {
			if (known.file_size === size && known.file_mtime >= mtime)
				return undefined;
			// Truncation or rotation: the file shrank below the watermark, so the
			// prefix the stored offsets describe is gone.
			if (size >= known.ingest_offset && size >= known.file_size)
				return {
					start: known.ingest_offset,
					lineIndex: known.line_index,
					reset: false,
				};
		}
		return { start: 0, lineIndex: 0, reset: true };
	}

	/** Write one window's spans and advance the watermark in the same
	 * transaction, so an interrupted ingest resumes at the next unparsed line
	 * instead of replaying (and duplicating) the spans it already wrote. */
	private writeWindow(
		changeId: string,
		source: TraceSource,
		spans: readonly SpanData[],
		watermark: IngestWatermark,
	): number {
		const write = this.db.transaction(() => {
			for (const span of spans)
				this.ingestStmt.run({ $change_id: changeId, ...traceColumns(span) });
			this.upsertWorkspaceStmt.run({
				$change_id: changeId,
				$path: source.path,
				$mtime: watermark.mtime,
				$size: watermark.size,
				$offset: watermark.offset,
				$line_index: watermark.lineIndex,
			});
		});
		write();
		return spans.length;
	}

	/** Keep the per-workflow span cap the database-level retention intends.
	 * Append-only ingest never drops a row, so the cap is enforced by dropping
	 * the oldest rows once a workflow passes it; the check only costs a count for
	 * a file with more lines than the cap, and nothing at all below it. */
	private trimToCap(changeId: string, lineIndex: number): void {
		if (lineIndex <= MAX_TELEMETRY_SPANS) return;
		const total = (this.traceCountStmt.get(changeId) as { count: number })
			.count;
		if (total <= MAX_TELEMETRY_SPANS) return;
		this.trimTracesStmt.run({
			$change_id: changeId,
			$keep: MAX_TELEMETRY_SPANS,
		});
	}

	/** One-time materialization of the aggregated columns for rows ingested
	 * before they existed. Batched and transactional, and advanced by row id, so
	 * an interrupted run resumes at the next batch and a malformed span that
	 * cannot be materialized is processed once instead of re-selected forever. */
	private backfillTraceColumns(): void {
		// Mirror `traceColumns`: a row needs backfill when a materialized column
		// is missing and the span JSON carries a value the writer accepts.
		// `json_type(..., '$.name') = 'text'` is exactly the string the writer
		// materializes, so a non-string name is left as raw telemetry and cannot
		// trap the loop. Matching `id > $lastId` also makes termination hold for
		// the pre-existing `start_nanos IS NULL` clause when a malformed span has
		// no valid start time.
		const needsBackfill =
			"start_nanos IS NULL OR (name IS NULL AND json_type(span, '$.name') = 'text')";
		const update = this.db.prepare(
			"UPDATE traces SET start_nanos=$start_nanos, end_nanos=$end_nanos, status_code=$status_code, role=$role, name=$name WHERE id=$id",
		);
		let lastId = 0;
		for (;;) {
			const rows = this.db
				.query(
					`SELECT id, span FROM traces
           WHERE id > $lastId AND (${needsBackfill})
           ORDER BY id LIMIT 5000`,
				)
				.all({ $lastId: lastId }) as Array<{ id: number; span: string }>;
			if (!rows.length) return;
			lastId = rows[rows.length - 1]?.id ?? lastId;
			const batch = this.db.transaction(() => {
				for (const row of rows) {
					const { $span, ...columns } = traceColumns(JSON.parse(row.span));
					void $span;
					update.run({ $id: row.id, ...columns });
				}
			});
			batch();
		}
	}

	/** One page of trace summaries — one entry per workflow (change id), newest
	 * first — plus the total the filter matches. This is the trace list's source
	 * of truth: the view never derives its rows from loaded span sets. */
	listTraceSummaries(
		options: { page?: number; perPage?: number; changeId?: string } = {},
	): TraceSummaryPage {
		const perPage = Math.max(
			1,
			Math.min(options.perPage ?? TRACE_PAGE_SIZE, MAX_TRACE_LIST_PER_PAGE),
		);
		const page = Math.max(1, Math.floor(options.page ?? 1));
		const filter = options.changeId ? " WHERE change_id = $change_id" : "";
		const params: Record<string, string> = {};
		if (options.changeId) params.$change_id = options.changeId;
		const total = (
			this.db
				.query(`SELECT COUNT(DISTINCT change_id) count FROM traces${filter}`)
				.get(params) as { count: number }
		).count;
		const rows = this.db
			.query(
				`SELECT change_id changeId,
                COUNT(*) spanCount,
                SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) errorCount,
                CAST(MIN(start_nanos) AS TEXT) startNanos,
                CAST(MAX(end_nanos) AS TEXT) endNanos,
                GROUP_CONCAT(DISTINCT role) roles,
                json_group_array(DISTINCT name) spanNames
         FROM traces${filter}
         GROUP BY change_id
         ORDER BY MIN(start_nanos) DESC, change_id DESC
         LIMIT $limit OFFSET $offset`,
			)
			.all({
				...params,
				$limit: perPage,
				$offset: (page - 1) * perPage,
			}) as Array<{
			changeId: string;
			spanCount: number;
			errorCount: number | null;
			startNanos: string | null;
			endNanos: string | null;
			roles: string | null;
			spanNames: string | null;
		}>;
		const items: TraceSummaryRow[] = rows.map((row) => ({
			changeId: row.changeId,
			spanCount: row.spanCount,
			errorCount: row.errorCount ?? 0,
			startNanos: row.startNanos ?? "0",
			endNanos: row.endNanos ?? "0",
			agents: row.roles ? row.roles.split(",").filter(Boolean) : [],
			spanNames: parseSpanNames(row.spanNames),
		}));
		return { items, total, page, perPage };
	}

	/** The newest spans across every workflow, in chronological order. Bounded
	 * on purpose: it feeds the service graph when the topology view is opened,
	 * which needs recent edges rather than the whole history. */
	recentSpans(limit = RECENT_SPAN_LIMIT): SpanData[] {
		const rows = this.db
			.query(
				`SELECT span FROM traces WHERE start_nanos IS NOT NULL ORDER BY start_nanos DESC LIMIT $limit`,
			)
			.all({
				$limit: Math.max(1, Math.min(limit, MAX_TELEMETRY_SPANS)),
			}) as Array<{ span: string }>;
		return rows.reverse().map((row) => JSON.parse(row.span) as SpanData);
	}

	/** Paged trace-list read (the `TelemetryDb` surface). */
	async fetchTracePage(options: {
		page: number;
		perPage: number;
		changeId?: string;
	}): Promise<TraceSummaryPage> {
		return this.listTraceSummaries(options);
	}

	async fetchTraceSpans(changeId: string): Promise<SpanData[]> {
		return this.loadSpans(changeId);
	}

	async fetchRecentSpans(limit = RECENT_SPAN_LIMIT): Promise<SpanData[]> {
		return this.recentSpans(limit);
	}

	async refreshWorkspaces(): Promise<
		Array<{
			changeId: string;
			path: string;
			spanCount: number;
		}>
	> {
		return this.getWorkspaces();
	}

	async scanRepositories(roots: readonly string[]): Promise<number> {
		let scanned = 0;
		for (const root of new Set(roots))
			scanned += await this.scanAllWorkspacesAsync(root);
		return scanned;
	}

	async watchRepositories(roots: readonly string[]): Promise<void> {
		for (const root of new Set(roots)) {
			if (this.watchedRepos.has(root)) continue;
			const unwatch = this.watchWorkspaces(root, () => this.notifyChange());
			this.watchedRepos.set(root, unwatch);
		}
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notifyChange(): void {
		for (const listener of this.listeners) listener();
	}

	ingestSpan(changeId: string, span: unknown): void {
		this.ingestStmt.run({ $change_id: changeId, ...traceColumns(span) });
	}

	ingestWorkspace(herdrPath: string, changeId: string): number {
		const source = workspaceTraceSource(herdrPath);
		if (!source) return 0;
		const stat = statSync(source.path);
		const size = stat.size;
		const mtime = Math.floor(stat.mtimeMs);
		if (size > MAX_TRACE_BYTES) return 0;
		const plan = this.planIngest(
			source,
			size,
			mtime,
			this.workspaceFileState(changeId),
		);
		if (!plan) return 0;
		const window = readWindowSync(source.path, plan.start, size);
		const consumed = consumedLineBytes(window);
		if (consumed === 0) {
			// Only a half-written line so far: remember the check (an unchanged file
			// is skipped by (mtime,size)) and retry the line on the next tick.
			if (!plan.reset)
				this.writeWindow(changeId, source, [], {
					mtime,
					size,
					offset: plan.start,
					lineIndex: plan.lineIndex,
				});
			return 0;
		}
		const text = window.subarray(0, consumed).toString("utf8");
		const lineIndex = plan.lineIndex + jsonlLines(text).length;
		// A full re-ingest replaces what the workflow had: its old rows describe a
		// file prefix that is gone, or one this parser version never wrote.
		if (plan.reset)
			this.db.run("DELETE FROM traces WHERE change_id=?", [changeId]);
		const parsed = source.parse(text, plan.lineIndex);
		// Keep the trailing window: append-only telemetry must retain the newest
		// events, matching the DB-level cap's recency intent.
		const spans = plan.reset ? parsed.slice(-MAX_TELEMETRY_SPANS) : parsed;
		const written = this.writeWindow(changeId, source, spans, {
			mtime,
			size,
			offset: plan.start + consumed,
			lineIndex,
		});
		this.trimToCap(changeId, lineIndex);
		return written;
	}

	ingestMetrics(changeId: string, metrics: MetricData[]): number {
		const insert = this.db.transaction(() => {
			for (const metric of metrics) {
				this.ingestMetricStmt.run({
					$change_id: changeId,
					$metric: JSON.stringify(metric),
				});
			}
		});
		insert();
		return metrics.length;
	}

	ingestLogs(changeId: string, logs: LogData[]): number {
		const insert = this.db.transaction(() => {
			for (const log of logs) {
				this.ingestLogStmt.run({
					$change_id: changeId,
					$log: JSON.stringify(log),
				});
			}
		});
		insert();
		return logs.length;
	}

	loadMetrics(changeId?: string): MetricData[] {
		const rows = changeId
			? (this.db
					.prepare("SELECT metric FROM metrics WHERE change_id=? ORDER BY id")
					.all(changeId) as MetricRow[])
			: (this.db
					.prepare("SELECT metric FROM metrics ORDER BY id")
					.all() as MetricRow[]);
		return rows.map((r) => JSON.parse(r.metric) as MetricData);
	}

	loadLogs(changeId?: string): LogData[] {
		const rows = changeId
			? (this.db
					.prepare("SELECT log FROM logs WHERE change_id=? ORDER BY id")
					.all(changeId) as LogRow[])
			: (this.db.prepare("SELECT log FROM logs ORDER BY id").all() as LogRow[]);
		return rows.map((r) => JSON.parse(r.log) as LogData);
	}

	loadSpans(changeId?: string): SpanData[] {
		const rows = changeId
			? (this.db
					.prepare(
						`SELECT span FROM traces WHERE change_id=? ORDER BY id LIMIT ${MAX_TELEMETRY_SPANS}`,
					)
					.all(changeId) as TraceRow[])
			: (this.db
					.prepare(
						// Keep the most recently ingested spans when the global cap is hit,
						// otherwise new workflows silently never load.
						`SELECT span FROM traces ORDER BY id DESC LIMIT ${MAX_TELEMETRY_SPANS}`,
					)
					.all() as TraceRow[]);
		if (!changeId) rows.reverse();
		return rows.map((r) => JSON.parse(r.span) as SpanData);
	}

	cleanupOlderThan(days = 30): number {
		const cutoff = BigInt(Date.now() - days * 86_400_000) * 1_000_000n;
		const result = this.db.run(
			"DELETE FROM traces WHERE CAST(json_extract(span, '$.endTimeUnixNano') AS INTEGER) < ?",
			[cutoff],
		);
		this.db.run(
			"DELETE FROM metrics WHERE CAST(json_extract(metric, '$.dataPoints[0].timeUnixNano') AS INTEGER) < ?",
			[cutoff],
		);
		this.db.run(
			"DELETE FROM logs WHERE CAST(json_extract(log, '$.timeUnixNano') AS INTEGER) < ?",
			[cutoff],
		);
		this.db.run(
			"DELETE FROM workspace_files WHERE NOT EXISTS (SELECT 1 FROM traces WHERE traces.change_id = workspace_files.change_id) AND NOT EXISTS (SELECT 1 FROM metrics WHERE metrics.change_id = workspace_files.change_id) AND NOT EXISTS (SELECT 1 FROM logs WHERE logs.change_id = workspace_files.change_id)",
		);
		return Number(result.changes ?? 0);
	}

	getWorkspaces(): Array<{
		changeId: string;
		path: string;
		spanCount: number;
	}> {
		return this.db
			.prepare(`
      SELECT w.change_id AS changeId, w.path, COUNT(t.id) AS spanCount
      FROM workspace_files w LEFT JOIN traces t ON w.change_id = t.change_id
      GROUP BY w.change_id ORDER BY w.change_id
    `)
			.all() as Array<{ changeId: string; path: string; spanCount: number }>;
	}

	async scanAllWorkspacesAsync(repoRoot: string): Promise<number> {
		const workflowDir = join(repoRoot, ".herdr-workflow");
		if (!existsSync(workflowDir)) return 0;
		let total = 0;
		try {
			const entries = readdirSync(workflowDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				await Bun.sleep(0);
				total += this.ingestWorkspace(
					join(workflowDir, entry.name),
					entry.name,
				);
			}
		} catch (e) {
			console.error("scanAllWorkspaces error:", e);
		}
		return total;
	}

	scanAllWorkspaces(repoRoot: string): number {
		const workflowDir = join(repoRoot, ".herdr-workflow");
		if (!existsSync(workflowDir)) return 0;
		let total = 0;
		try {
			const entries = readdirSync(workflowDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const count = this.ingestWorkspace(
					join(workflowDir, entry.name),
					entry.name,
				);
				total += count;
			}
		} catch (e) {
			console.error("scanAllWorkspaces error:", e);
		}
		return total;
	}

	watchWorkspaces(
		repoRoot: string,
		onNew: (changeId: string, spans: SpanData[]) => void,
	): () => void {
		const timer = setInterval(() => {
			void this.ingestRepository(repoRoot, onNew).catch((error) =>
				console.error("watchWorkspaces error:", error),
			);
		}, WORKSPACE_WATCH_MS);
		return () => clearInterval(timer);
	}

	/** One watcher tick: ingest what was appended to every workspace file of a
	 * repository. Only appended bytes are read and parsed, and the parse runs in
	 * bounded chunks with a yield between them, so a long telemetry file never
	 * holds the event loop of the process the watcher runs in. */
	private async ingestRepository(
		repoRoot: string,
		onNew: (changeId: string, spans: SpanData[]) => void,
	): Promise<void> {
		const workflowDir = join(repoRoot, ".herdr-workflow");
		if (!existsSync(workflowDir)) return;
		const entries = readdirSync(workflowDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (this.ingesting.has(entry.name)) continue;
			const source = workspaceTraceSource(join(workflowDir, entry.name));
			if (!source) continue;
			let size = 0;
			let mtime = 0;
			try {
				const stat = statSync(source.path);
				size = stat.size;
				mtime = Math.floor(stat.mtimeMs);
			} catch {
				// The workspace file was rotated away between the directory read and
				// the stat: the next tick sees the new one.
				continue;
			}
			if (size > MAX_TRACE_BYTES) continue;
			const plan = this.planIngest(
				source,
				size,
				mtime,
				this.workspaceFileState(entry.name),
			);
			if (!plan) continue;
			this.ingesting.add(entry.name);
			try {
				const spans = await this.ingestTail(entry.name, source, {
					size,
					mtime,
					plan,
				});
				if (spans.length) onNew(entry.name, spans);
			} finally {
				this.ingesting.delete(entry.name);
			}
		}
	}

	/** Parse and store the appended tail of one workspace file. */
	private async ingestTail(
		changeId: string,
		source: TraceSource,
		window: { size: number; mtime: number; plan: IngestPlan },
	): Promise<SpanData[]> {
		const { plan, size, mtime } = window;
		const bytes = await readWindowAsync(source.path, plan.start, size);
		const consumed = consumedLineBytes(bytes);
		if (consumed === 0) {
			// Only a half-written line so far, and no complete line to renumber from
			// on a full re-ingest: leave the watermark where it is.
			if (!plan.reset)
				this.writeWindow(changeId, source, [], {
					mtime,
					size,
					offset: plan.start,
					lineIndex: plan.lineIndex,
				});
			return [];
		}
		const lines = jsonlLines(bytes.subarray(0, consumed).toString("utf8"));
		if (plan.reset)
			this.db.run("DELETE FROM traces WHERE change_id=?", [changeId]);
		const parsed: SpanData[] = [];
		let lineIndex = plan.lineIndex;
		for (let start = 0; start < lines.length; start += INGEST_CHUNK_LINES) {
			for (const line of lines.slice(start, start + INGEST_CHUNK_LINES)) {
				lineIndex += 1;
				const span = source.parseLine(line, lineIndex);
				if (span) parsed.push(span);
			}
			// Yield to the event loop between chunks: this parse is main-thread work
			// in the process that hosts the watcher.
			await Bun.sleep(0);
		}
		const spans = plan.reset ? parsed.slice(-MAX_TELEMETRY_SPANS) : parsed;
		this.writeWindow(changeId, source, spans, {
			mtime,
			size,
			offset: plan.start + consumed,
			lineIndex,
		});
		this.trimToCap(changeId, lineIndex);
		return spans;
	}

	close() {
		for (const unwatch of this.watchedRepos.values()) unwatch();
		this.watchedRepos.clear();
		this.listeners.clear();
		this.db.close();
	}
}

/** Canonical project roots from the configured project catalog. Throws when
 * the catalog is unavailable so callers can show a retryable discovery error
 * instead of watching nothing as if the catalog were empty. */
export async function discoverProjectRepos(
	serverUrl?: string,
): Promise<string[]> {
	const catalog = await loadProjectCatalog({ baseUrl: serverUrl });
	return projectCanonicalRoots(catalog);
}
