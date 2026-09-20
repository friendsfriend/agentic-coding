// Server-owned telemetry persistence and query boundary
// (expose-unified-bun-backend, task 2.3). The server owns the SQLite trace
// database, workspace scanning and retention; the TUI reads through the typed
// client instead of opening the database or watching workspace files.
//
// The service is transport-agnostic: `app.ts` exposes the paged trace list,
// per-workflow span reads, workspaces, scan/watch and prune over the
// authenticated API, and the composition root decides when it is created and
// closed.

import {
	RECENT_SPAN_LIMIT,
	type SpanData,
	type TraceSummaryPage,
} from "../contracts/telemetry.ts";
import { TraceDb } from "./telemetry-db";

export interface TelemetryWorkspace {
	readonly changeId: string;
	readonly path: string;
	readonly spanCount: number;
}

/** Query/retention surface the server exposes over the API. The trace list is
 * paged (one entry per workflow, newest first) and spans are fetched per
 * workflow, so no request ships the whole history. */
export interface TelemetryOperations {
	summaries(options?: {
		page?: number;
		perPage?: number;
		changeId?: string;
	}): TraceSummaryPage;
	workspaces(): TelemetryWorkspace[];
	traceSpans(changeId: string): SpanData[];
	/** Newest spans across workflows, for the service graph. */
	recentSpans(limit?: number): SpanData[];
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

	summaries(
		options: { page?: number; perPage?: number; changeId?: string } = {},
	): TraceSummaryPage {
		return this.db.listTraceSummaries(options);
	}

	workspaces(): TelemetryWorkspace[] {
		return this.db.getWorkspaces();
	}

	traceSpans(changeId: string): SpanData[] {
		return this.db.loadSpans(changeId);
	}

	recentSpans(limit = RECENT_SPAN_LIMIT): SpanData[] {
		return this.db.recentSpans(limit);
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
