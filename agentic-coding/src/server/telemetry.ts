// Server-owned telemetry persistence and query boundary
// (expose-unified-bun-backend, task 2.3). The server owns the SQLite trace
// database, workspace scanning and retention; the TUI reads through the typed
// client instead of opening the database or watching workspace files.
//
// The service is transport-agnostic: `app.ts` exposes `snapshot`/`scan`/`prune`
// over the authenticated API, and the composition root decides when it is
// created and closed.
import { TraceDb } from "../tui/otel/model/db.ts";
import type { LogData, MetricData, SpanData } from "../tui/otel/model/types.ts";

export interface TelemetryWorkspace {
	readonly changeId: string;
	readonly path: string;
	readonly spanCount: number;
}

export interface TelemetrySnapshot {
	readonly workspaces: TelemetryWorkspace[];
	/** Spans for every workspace, keyed by change id (for per-workspace views). */
	readonly spansByChange: Record<string, SpanData[]>;
	readonly spans: SpanData[];
	readonly metrics: MetricData[];
	readonly logs: LogData[];
}

/** Query/retention surface the server exposes over the API. */
export interface TelemetryOperations {
	snapshot(changeId?: string): TelemetrySnapshot;
	scan(repo: string): Promise<number>;
	prune(days?: number): number;
	/** Watch a repository's workspace files server-side; `onChange` fires after
	 * the database ingests new spans. Optional so tests can inject a stub. */
	watch?(repo: string, onChange: (changeId: string) => void): () => void;
}

export class TelemetryService implements TelemetryOperations {
	readonly db: TraceDb;
	private readonly watchers = new Map<string, () => void>();

	constructor(dbPath?: string) {
		this.db = new TraceDb(dbPath);
	}

	snapshot(changeId?: string): TelemetrySnapshot {
		const workspaces = this.db.getWorkspaces();
		const spansByChange: Record<string, SpanData[]> = {};
		for (const workspace of workspaces)
			spansByChange[workspace.changeId] = this.db.loadSpans(workspace.changeId);
		return {
			workspaces,
			spansByChange,
			spans: this.db.loadSpans(changeId),
			metrics: this.db.loadMetrics(changeId),
			logs: this.db.loadLogs(changeId),
		};
	}

	async scan(repo: string): Promise<number> {
		return this.db.scanAllWorkspacesAsync(repo);
	}

	prune(days = 30): number {
		return this.db.cleanupOlderThan(days);
	}

	/** Server-owned watcher: one polling watcher per repository, released on
	 * close. `onChange` fires after the database has ingested the new spans. */
	watch(repo: string, onChange: (changeId: string) => void): () => void {
		const existing = this.watchers.get(repo);
		if (existing) return existing;
		const unwatch = this.db.watchWorkspaces(repo, (changeId) =>
			onChange(changeId),
		);
		this.watchers.set(repo, unwatch);
		return unwatch;
	}

	close(): void {
		for (const unwatch of this.watchers.values()) unwatch();
		this.watchers.clear();
		this.db.close();
	}
}
