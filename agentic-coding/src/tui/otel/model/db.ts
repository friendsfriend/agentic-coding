import { Database, type Statement } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	loadProjectCatalog,
	projectCanonicalRoots,
} from "../../../workflow/project-catalog.ts";
import { parseJsonl, parseTelemetryJsonl } from "./parser";
import {
	type LogData,
	type MetricData,
	RECENT_SPAN_LIMIT,
	type SpanData,
	TRACE_PAGE_SIZE,
	type TraceSummaryPage,
	type TraceSummaryRow,
} from "./types";

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
/** Bumped whenever the ingest parser changes so existing workspaces re-ingest. */
const PARSER_VERSION = 3;

interface TraceSource {
	path: string;
	parse: (text: string) => SpanData[];
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
			? { path: telemetryPath, parse: parseTelemetryJsonl }
			: { path: legacyPath, parse: parseJsonl };
	}
	if (telemetryExists)
		return { path: telemetryPath, parse: parseTelemetryJsonl };
	if (legacyExists) return { path: legacyPath, parse: parseJsonl };
	return undefined;
}

/** The aggregated trace-list columns for one ingested span. A malformed span
 * document must not abort a whole workspace ingest, so anything unreadable
 * contributes NULL columns and the row stays visible as raw telemetry. */
function traceColumns(span: unknown): Record<string, string | number | null> {
	const record = span as {
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
		$start_nanos: nanos(record?.startTimeUnixNano),
		$end_nanos: nanos(record?.endTimeUnixNano),
		$status_code:
			typeof record?.status?.code === "number" ? record.status.code : null,
		$role: role,
	};
}

export class TraceDb {
	private db: Database;
	private readonly ingesting = new Set<string>();
	private ingestStmt: Statement;
	private ingestMetricStmt: Statement;
	private ingestLogStmt: Statement;
	private upsertWorkspaceStmt: Statement;
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
      parser_version INTEGER NOT NULL DEFAULT 1
    )`);
		try {
			this.db.run(
				"ALTER TABLE workspace_files ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 1",
			);
		} catch (error) {
			if (!String(error).includes("duplicate column name")) throw error;
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
			`INSERT INTO traces (change_id, span, start_nanos, end_nanos, status_code, role, ingested_at)
       VALUES ($change_id, $span, $start_nanos, $end_nanos, $status_code, $role, datetime('now'))`,
		);
		this.ingestMetricStmt = this.db.prepare(
			"INSERT INTO metrics (change_id, metric, ingested_at) VALUES ($change_id, $metric, datetime('now'))",
		);
		this.ingestLogStmt = this.db.prepare(
			"INSERT INTO logs (change_id, log, ingested_at) VALUES ($change_id, $log, datetime('now'))",
		);
		this.upsertWorkspaceStmt = this.db.prepare(
			`INSERT INTO workspace_files (change_id, path, file_mtime, parser_version) VALUES ($change_id, $path, $mtime, ${PARSER_VERSION}) ON CONFLICT(change_id) DO UPDATE SET path=$path, file_mtime=$mtime, parser_version=${PARSER_VERSION}`,
		);
	}

	/** One-time materialization of the aggregated columns for rows ingested
	 * before they existed. Batched and transactional, so an interrupted run
	 * resumes at the next batch instead of starting over. */
	private backfillTraceColumns(): void {
		const pending = this.db
			.query("SELECT COUNT(*) count FROM traces WHERE start_nanos IS NULL")
			.get() as { count: number };
		if (!pending.count) return;
		const update = this.db.prepare(
			"UPDATE traces SET start_nanos=$start_nanos, end_nanos=$end_nanos, status_code=$status_code, role=$role WHERE id=$id",
		);
		for (;;) {
			const rows = this.db
				.query(
					"SELECT id, span FROM traces WHERE start_nanos IS NULL LIMIT 5000",
				)
				.all() as Array<{ id: number; span: string }>;
			if (!rows.length) return;
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
                GROUP_CONCAT(DISTINCT role) roles
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
		}>;
		const items: TraceSummaryRow[] = rows.map((row) => ({
			changeId: row.changeId,
			spanCount: row.spanCount,
			errorCount: row.errorCount ?? 0,
			startNanos: row.startNanos ?? "0",
			endNanos: row.endNanos ?? "0",
			agents: row.roles ? row.roles.split(",").filter(Boolean) : [],
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
		const mtime = Math.floor(statSync(source.path).mtimeMs);
		const known = this.db
			.prepare(
				"SELECT file_mtime, parser_version FROM workspace_files WHERE change_id=?",
			)
			.get(changeId) as
			| { file_mtime: number; parser_version?: number }
			| undefined;
		if (
			known &&
			known.file_mtime >= mtime &&
			(known.parser_version ?? 1) >= PARSER_VERSION
		)
			return 0;
		if (statSync(source.path).size > MAX_TRACE_BYTES) return 0;
		const text = readFileSync(source.path, "utf8");
		// Keep the trailing window: append-only telemetry must retain the newest
		// events, matching the DB-level cap's recency intent.
		const spans = source.parse(text).slice(-MAX_TELEMETRY_SPANS);
		// Remove old traces for this change and re-ingest
		this.db.run("DELETE FROM traces WHERE change_id=?", [changeId]);
		const insert = this.db.transaction(() => {
			for (const span of spans) {
				this.ingestStmt.run({ $change_id: changeId, ...traceColumns(span) });
			}
			this.upsertWorkspaceStmt.run({
				$change_id: changeId,
				$path: source.path,
				$mtime: mtime,
			});
		});
		insert();
		return spans.length;
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
			const workflowDir = join(repoRoot, ".herdr-workflow");
			if (!existsSync(workflowDir)) return;
			try {
				const entries = readdirSync(workflowDir, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isDirectory()) continue;
					const source = workspaceTraceSource(join(workflowDir, entry.name));
					if (!source) continue;
					const mtime = Math.floor(statSync(source.path).mtimeMs);
					const known = this.db
						.prepare(
							"SELECT file_mtime, parser_version FROM workspace_files WHERE change_id=?",
						)
						.get(entry.name) as
						| { file_mtime: number; parser_version?: number }
						| undefined;
					if (
						known &&
						known.file_mtime >= mtime &&
						(known.parser_version ?? 1) >= PARSER_VERSION
					)
						continue;
					if (this.ingesting.has(entry.name)) continue;
					if (statSync(source.path).size > MAX_TRACE_BYTES) continue;
					this.ingesting.add(entry.name);
					void (async () => {
						const text = await Bun.file(source.path).text();
						const spans = source.parse(text).slice(-MAX_TELEMETRY_SPANS);
						this.db.run("DELETE FROM traces WHERE change_id=?", [entry.name]);
						const insert = this.db.transaction(() => {
							for (const span of spans) {
								this.ingestStmt.run({
									$change_id: entry.name,
									...traceColumns(span),
								});
							}
							this.upsertWorkspaceStmt.run({
								$change_id: entry.name,
								$path: source.path,
								$mtime: mtime,
							});
						});
						insert();
						onNew(entry.name, spans);
					})()
						.catch((error) => console.error("watchWorkspaces error:", error))
						.finally(() => this.ingesting.delete(entry.name));
				}
			} catch (e) {
				console.error("watchWorkspaces error:", e);
			}
		}, 2000);
		return () => clearInterval(timer);
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
