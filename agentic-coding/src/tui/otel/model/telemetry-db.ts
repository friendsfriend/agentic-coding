// Structural interface for the telemetry database consumed by the OTEL feature
// (expose-unified-bun-backend, task 2.3). The shell passes either the local
// `TraceDb` (demo mode) or the server-backed `RemoteTelemetryDb`; the views
// only depend on this read/query surface, never on the concrete database.
import type { LogData, MetricData, SpanData } from "./types.ts";

export interface TelemetryDb {
	getWorkspaces(): Array<{
		changeId: string;
		path: string;
		spanCount: number;
	}>;
	loadSpans(changeId?: string): SpanData[];
	loadMetrics(changeId?: string): MetricData[];
	loadLogs(changeId?: string): LogData[];
	cleanupOlderThan(days?: number): number;
	watchWorkspaces(
		repoRoot: string,
		onNew: (changeId: string, spans: SpanData[]) => void,
	): () => void;
	scanAllWorkspacesAsync(repoRoot: string): Promise<number>;
	close(): void;
}
