// Structural interface for the telemetry database consumed by the OTEL feature
// (expose-unified-bun-backend, task 2.3). The shell passes either the local
// `TraceDb` (demo mode) or the server-backed `RemoteTelemetryDb`; the views
// only depend on this read/query surface, never on the concrete database.
//
// The trace list is paged and spans are fetched per workflow, so opening the
// observability feature reads one page plus one workflow's spans instead of the
// whole history.
import type { SpanData, TraceSummaryPage } from "./types.ts";

export interface TelemetryWorkspace {
	changeId: string;
	path: string;
	spanCount: number;
}

export interface TelemetryDb {
	/** Cached workspace list (the workspace filter and prune views). */
	getWorkspaces(): TelemetryWorkspace[];
	/** Re-read the workspace list from the database and return it. */
	refreshWorkspaces(): Promise<TelemetryWorkspace[]>;
	/** One page of trace summaries — one entry per workflow, newest first. */
	fetchTracePage(options: {
		page: number;
		perPage: number;
		changeId?: string;
	}): Promise<TraceSummaryPage>;
	/** Every span of one workflow (the span tree and span detail). */
	fetchTraceSpans(changeId: string): Promise<SpanData[]>;
	/** The newest spans across workflows, for the service graph. */
	fetchRecentSpans(limit?: number): Promise<SpanData[]>;
	/** Register the workspace watchers for these repositories; new telemetry is
	 * announced through `onChange` instead of being polled by each surface. */
	watchRepositories(roots: readonly string[]): Promise<void>;
	scanRepositories(roots: readonly string[]): Promise<number>;
	/** Subscribe to "telemetry changed" notifications. */
	onChange(listener: () => void): () => void;
	/** Retention is owner-side; the removal count may only be known later. */
	cleanupOlderThan(days?: number): number;
	close(): void;
}
