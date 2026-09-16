// Server-backed telemetry database (expose-unified-bun-backend, task 2.3).
// The server owns the SQLite database, workspace scanning and retention; this
// proxy reads through the authenticated API. It never opens the database or
// watches workspace files itself.
//
// Reads are paged (one page of trace rows at a time) and spans are fetched per
// workflow, so no request ships the whole history and opening observability
// costs one page instead of a full telemetry download.
import type { BackendClient } from "../../../server/client.ts";
import type { TelemetryDb, TelemetryWorkspace } from "./telemetry-db.ts";
import {
	RECENT_SPAN_LIMIT,
	type SpanData,
	type TraceSummaryPage,
} from "./types.ts";

export class RemoteTelemetryDb implements TelemetryDb {
	private client?: BackendClient;
	private workspaces: TelemetryWorkspace[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly watched = new Set<string>();
	private unsubscribe?: () => void;

	/** Bind the authenticated transport once the shell has configured it. */
	setClient(client: BackendClient): void {
		this.client = client;
	}

	getWorkspaces(): TelemetryWorkspace[] {
		return this.workspaces;
	}

	async refreshWorkspaces(): Promise<TelemetryWorkspace[]> {
		const previous = this.workspaces;
		const next = await this.readWorkspaces();
		const changed =
			next.length !== previous.length ||
			next.some(
				(workspace, index) =>
					workspace.changeId !== previous[index]?.changeId ||
					workspace.spanCount !== previous[index]?.spanCount,
			);
		if (changed) this.notify();
		return next;
	}

	private async readWorkspaces(): Promise<TelemetryWorkspace[]> {
		const client = this.client;
		if (!client) return this.workspaces;
		this.workspaces =
			(await client.telemetryWorkspaces()) as TelemetryWorkspace[];
		return this.workspaces;
	}

	fetchTracePage(options: {
		page: number;
		perPage: number;
		changeId?: string;
	}): Promise<TraceSummaryPage> {
		return this.requireClient().telemetryTraces(
			options,
		) as Promise<TraceSummaryPage>;
	}

	async fetchTraceSpans(changeId: string): Promise<SpanData[]> {
		const spans = (await this.requireClient().telemetrySpans({
			changeId,
		})) as SpanData[];
		return spans;
	}

	async fetchRecentSpans(limit = RECENT_SPAN_LIMIT): Promise<SpanData[]> {
		return (await this.requireClient().telemetrySpans({ limit })) as SpanData[];
	}

	async watchRepositories(roots: readonly string[]): Promise<void> {
		const client = this.client;
		if (!client) return;
		// The server owns one watcher per repository; registering is idempotent
		// there, and this set keeps a second shell from asking twice.
		for (const root of new Set(roots)) {
			if (this.watched.has(root)) continue;
			this.watched.add(root);
			try {
				await client.telemetryWatch(root);
			} catch {
				// A repository the server cannot watch is not a startup failure: the
				// paged read still sees whatever was ingested.
				this.watched.delete(root);
			}
		}
		this.ensureSubscription();
	}

	async scanRepositories(roots: readonly string[]): Promise<number> {
		const client = this.client;
		if (!client) return 0;
		let scanned = 0;
		for (const root of new Set(roots))
			scanned += await client.telemetryScan(root);
		await this.refreshWorkspaces();
		return scanned;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		this.ensureSubscription();
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Retention is server-owned; this returns 0 because the removal count is
	 * only available asynchronously. The following refresh reflects the result. */
	cleanupOlderThan(days?: number): number {
		void this.client
			?.telemetryPrune(days)
			.then(() => this.refreshWorkspaces())
			.catch(() => {});
		return 0;
	}

	close(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.listeners.clear();
		this.watched.clear();
	}

	private requireClient(): BackendClient {
		if (!this.client) throw new Error("telemetry client is not configured yet");
		return this.client;
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	/** Subscribe to server telemetry events once: the server announces ingested
	 * workspace telemetry, so the shell refreshes its page from the API instead
	 * of watching workspace files. */
	private ensureSubscription(): void {
		if (this.unsubscribe || !this.listeners.size || !this.client) return;
		this.unsubscribe = this.client.subscribe({
			onEvent: (event) => {
				// Any telemetry event can change the page content, not just the
				// workspace index, so notify unconditionally after re-reading it.
				if ((event as { domain?: string }).domain === "telemetry")
					void this.readWorkspaces().then(() => this.notify());
			},
			onResync: () => void this.readWorkspaces().then(() => this.notify()),
		});
	}
}
