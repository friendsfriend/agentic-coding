// Server-backed telemetry database (expose-unified-bun-backend, task 2.3).
// The server owns the SQLite database and workspace scanning; this proxy keeps
// the small synchronous read surface the OTEL views already use and refreshes
// its cache from the authenticated API. It never opens the database or watches
// workspace files itself.
import type { BackendClient } from "../../../server/client.ts";
import type { TelemetryDb } from "./telemetry-db.ts";
import type { LogData, MetricData, SpanData } from "./types.ts";

interface Snapshot {
	workspaces: Array<{ changeId: string; path: string; spanCount: number }>;
	spansByChange: Record<string, SpanData[]>;
	spans: SpanData[];
	metrics: MetricData[];
	logs: LogData[];
}

const EMPTY_SNAPSHOT: Snapshot = {
	workspaces: [],
	spansByChange: {},
	spans: [],
	metrics: [],
	logs: [],
};

interface Watcher {
	cb: (changeId: string, spans: SpanData[]) => void;
}

export class RemoteTelemetryDb implements TelemetryDb {
	private client?: BackendClient;
	private snapshot: Snapshot = EMPTY_SNAPSHOT;
	private readonly watchers = new Map<string, Set<Watcher>>();
	private unsubscribe?: () => void;
	private scansInFlight = 0;

	/** Bind the authenticated transport once the shell has configured it. */
	setClient(client: BackendClient): void {
		this.client = client;
	}

	/** Subscribe to server telemetry events once, so new workspace spans are
	 * pulled from the API instead of the client watching files. */
	private ensureSubscription(): void {
		if (this.unsubscribe || !this.client) return;
		this.unsubscribe = this.client.subscribe({
			onEvent: (event) => {
				const domain = (event as { domain?: string }).domain;
				if (domain === "telemetry") void this.refresh().catch(() => {});
			},
			onResync: () => void this.refresh().catch(() => {}),
		});
	}

	/** Fetch the authoritative snapshot and notify watchers when it changed. */
	async refresh(): Promise<void> {
		const client = this.client;
		// Scan events arrive for each repository; the batch refreshes once after
		// all scans finish instead of transferring the full history N times.
		if (!client || this.scansInFlight > 0) return;
		const next = (await client.telemetrySnapshot()) as Snapshot;
		const changed =
			next.spans.length !== this.snapshot.spans.length ||
			JSON.stringify(next.workspaces) !==
				JSON.stringify(this.snapshot.workspaces);
		this.snapshot = next;
		if (!changed) return;
		for (const watcher of this.watchers.values())
			for (const watcherEntry of watcher)
				for (const workspace of next.workspaces)
					watcherEntry.cb(
						workspace.changeId,
						next.spansByChange[workspace.changeId] ?? [],
					);
	}

	getWorkspaces(): Array<{
		changeId: string;
		path: string;
		spanCount: number;
	}> {
		return this.snapshot.workspaces;
	}

	loadSpans(changeId?: string): SpanData[] {
		return changeId
			? (this.snapshot.spansByChange[changeId] ?? [])
			: this.snapshot.spans;
	}

	loadMetrics(): MetricData[] {
		return this.snapshot.metrics;
	}

	loadLogs(): LogData[] {
		return this.snapshot.logs;
	}

	/** Retention is server-owned; this returns 0 because the removal count is
	 * only available asynchronously. The following refresh reflects the result. */
	cleanupOlderThan(): number {
		void this.client
			?.telemetryPrune()
			.then(() => this.refresh())
			.catch(() => {});
		return 0;
	}

	async scanAllWorkspacesAsync(repoRoot: string): Promise<number> {
		return this.scanRepositories([repoRoot]);
	}

	async scanRepositories(repoRoots: readonly string[]): Promise<number> {
		const client = this.client;
		if (!client) return 0;
		this.scansInFlight++;
		try {
			let scanned = 0;
			for (const root of new Set(repoRoots)) {
				scanned += await client.telemetryScan(root);
			}
			return scanned;
		} finally {
			this.scansInFlight--;
			await this.refresh();
		}
	}

	watchWorkspaces(
		repoRoot: string,
		onNew: (changeId: string, spans: SpanData[]) => void,
	): () => void {
		const watcher: Watcher = { cb: onNew };
		const set = this.watchers.get(repoRoot) ?? new Set<Watcher>();
		set.add(watcher);
		this.watchers.set(repoRoot, set);
		this.ensureSubscription();
		return () => {
			set.delete(watcher);
			if (set.size === 0) this.watchers.delete(repoRoot);
		};
	}

	close(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.watchers.clear();
	}
}
