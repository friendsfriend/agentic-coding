// Application-owned sidebar presentation lifecycle
// (improve-herdr-workflow-sidebar).
//
// One owner per long-lived Agentic Coding application: it rebuilds cards from
// current authoritative views plus live Herdr reads, coalesces overlapping
// refreshes, publishes bounded work, and installs the transient native Agents
// view once per connection. Observation owners stay separate from effect
// execution: nothing here drains the outbox, claims effects, or touches agent
// processes, and every failure is presentation-only.
import type { HerdrPort } from "./adapters.ts";
import type { WorkflowView } from "./contracts.ts";
import { herdrSidebarEnabled } from "./effects.ts";
import {
	projectSidebar,
	retainedRequiredPaneIds,
	SIDEBAR_ALL_PANE_TOKENS,
	SIDEBAR_ALL_WORKSPACE_TOKENS,
	SIDEBAR_PANE_TOKENS,
	type SidebarObservation,
	type SidebarPublication,
	standaloneClassifications,
} from "./sidebar.ts";
import {
	BoundedSidebarDiagnostics,
	clearSidebarView,
	installSidebarView,
	publishSidebar,
	readSidebarObservations,
	type SidebarDiagnostics,
} from "./sidebar-sync.ts";

export const SIDEBAR_FALLBACK_REFRESH_MS = 2_000;

export interface SidebarPresentationOptions {
	herdr: HerdrPort;
	/** Current authoritative views for the repositories this owner covers. */
	views: () => readonly WorkflowView[];
	socketPath?: string;
	diagnostics?: SidebarDiagnostics;
	refreshMs?: number;
}

/**
 * Explicit disable: clear only this integration's owned metadata and its
 * source-guarded custom view. Native names, workflow stores, agent processes,
 * other sources' tokens, and the row configuration are left untouched.
 */
export async function clearSidebarPresentation(options: {
	herdr: HerdrPort;
	views: () => readonly WorkflowView[];
	/** Ids published by earlier refreshes but absent from the current views. */
	extraPaneIds?: readonly string[];
	extraWorkspaceIds?: readonly string[];
	socketPath?: string;
	signal?: AbortSignal;
}): Promise<{ panes: number; workspaces: number }> {
	let views: readonly WorkflowView[] = [];
	try {
		views = options.views();
	} catch {
		/* an unreadable view source contributes no targets to clear */
	}
	const panes = [
		...new Set([
			...views.flatMap((view) =>
				view.runs.flatMap((run) => (run.paneId ? [run.paneId] : [])),
			),
			...(options.extraPaneIds ?? []),
		]),
	];
	const workspaces = [
		...new Set([
			...views.flatMap((view) => (view.workspace ? [view.workspace] : [])),
			...(options.extraWorkspaceIds ?? []),
		]),
	];
	await publishSidebar(
		options.herdr,
		{
			panes: [],
			workspaces: [],
			clearedPanes: panes.map((targetId) => ({
				targetId,
				tokens: SIDEBAR_ALL_PANE_TOKENS,
			})),
			clearedWorkspaces: workspaces.map((targetId) => ({
				targetId,
				tokens: SIDEBAR_ALL_WORKSPACE_TOKENS,
			})),
		},
		options.signal,
	);
	await clearSidebarView({
		...(options.socketPath ? { socketPath: options.socketPath } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	return { panes: panes.length, workspaces: workspaces.length };
}

/**
 * Reconcile once: read live topology, project, publish. Coalescing lives in
 * the owner (`SidebarPresentation.reconcile`); this one-shot path is what the
 * post-commit drain hook and the pre-wait question flush use, where a single
 * bounded refresh is all that is wanted.
 */
export async function reconcileSidebarOnce(
	options: SidebarPresentationOptions & {
		managedPaneIds?: readonly string[];
		managedWorkspaceIds?: readonly string[];
		retainedRequiredPanes?: readonly string[];
		signal?: AbortSignal;
	},
): Promise<SidebarPublication | undefined> {
	const diagnostics = options.diagnostics ?? new BoundedSidebarDiagnostics();
	try {
		const live = await readSidebarObservations(options.herdr, options.signal);
		const views = options.views();
		const publication = projectSidebar({
			views,
			observations: live.observations,
			unmanagedPanes: live.unmanagedPanes,
			unmanagedWorkspaces: live.unmanagedWorkspaces,
			livePaneIds: live.unmanagedPanes.map((pane) => pane.paneId),
			liveWorkspaceIds: live.unmanagedWorkspaces.map(
				(workspace) => workspace.workspaceId,
			),
			standalone: standaloneClassifications(views),
			...(options.managedPaneIds
				? { managedPaneIds: options.managedPaneIds }
				: {}),
			...(options.managedWorkspaceIds
				? { managedWorkspaceIds: options.managedWorkspaceIds }
				: {}),
			...(options.retainedRequiredPanes
				? { retainedRequiredPanes: options.retainedRequiredPanes }
				: {}),
		});
		await publishSidebar(
			options.herdr,
			publication,
			options.signal,
			diagnostics,
		);
		return publication;
	} catch (error) {
		diagnostics.report(error instanceof Error ? error.message : String(error));
		return undefined;
	}
}

/**
 * The long-lived presentation owner. Started by the TUI shell while home/dash
 * is alive; disposed on shell teardown. No daemon survives its disposal, and
 * disposal never clears another application's server-wide view.
 */
export class SidebarPresentation {
	private timer: ReturnType<typeof setInterval> | undefined;
	private controller: AbortController | undefined;
	private running: Promise<void> | undefined;
	private pending = false;
	private started = false;
	private disposed = false;
	private lastSignature: string | undefined;
	private managedPaneIds: readonly string[] = [];
	private managedWorkspaceIds: readonly string[] = [];
	private retainedRequiredPanes: readonly string[] = [];
	private lastObservations: readonly SidebarObservation[] = [];
	private readonly diagnostics: SidebarDiagnostics;
	private readonly refreshMs: number;

	constructor(private readonly options: SidebarPresentationOptions) {
		this.diagnostics = options.diagnostics ?? new BoundedSidebarDiagnostics();
		this.refreshMs = options.refreshMs ?? SIDEBAR_FALLBACK_REFRESH_MS;
	}

	/** Whether the trusted user preference enables this integration. */
	get enabled(): boolean {
		return herdrSidebarEnabled();
	}

	/**
	 * Start the owner: install the custom view once for this connection and
	 * begin the bounded fallback refresh. Idempotent.
	 */
	start(): void {
		if (this.started || this.disposed) return;
		this.started = true;
		void this.installView();
		this.timer = setInterval(() => void this.reconcile(), this.refreshMs);
	}

	private async installView(): Promise<void> {
		try {
			await installSidebarView({
				...(this.options.socketPath
					? { socketPath: this.options.socketPath }
					: {}),
				...(this.controller ? { signal: this.controller.signal } : {}),
			});
		} catch (error) {
			this.diagnostics.report(
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/** Reapply the view after a Herdr reconnect or server restart. */
	async reinstallView(): Promise<void> {
		if (this.disposed) return;
		await this.installView();
	}

	/**
	 * Reconcile presentation. Overlapping triggers coalesce into one running
	 * publication plus at most one follow-up, so bursts and self-generated
	 * metadata events cannot interleave writes.
	 */
	reconcile(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		this.pending = true;
		this.running ??= this.drain();
		return this.running;
	}

	private async drain(): Promise<void> {
		try {
			while (this.pending && !this.disposed) {
				this.pending = false;
				await this.refresh();
			}
		} finally {
			this.running = undefined;
		}
	}

	private async refresh(): Promise<void> {
		if (this.controller?.signal.aborted) this.controller = undefined;
		if (!this.controller) this.controller = new AbortController();
		const controller = this.controller;
		try {
			const live = await readSidebarObservations(
				this.options.herdr,
				controller.signal,
			);
			// Views are re-read after the live read so a reassignment during the
			// read cannot publish an obsolete association.
			const views = this.options.views();
			const publication = projectSidebar({
				views,
				observations: live.observations,
				unmanagedPanes: live.unmanagedPanes,
				unmanagedWorkspaces: live.unmanagedWorkspaces,
				livePaneIds: live.unmanagedPanes.map((pane) => pane.paneId),
				liveWorkspaceIds: live.unmanagedWorkspaces.map(
					(workspace) => workspace.workspaceId,
				),
				standalone: standaloneClassifications(views),
				managedPaneIds: this.managedPaneIds,
				managedWorkspaceIds: this.managedWorkspaceIds,
				retainedRequiredPanes: this.retainedRequiredPanes,
			});
			const signature = JSON.stringify(publication);
			if (signature === this.lastSignature) return;
			await publishSidebar(
				this.options.herdr,
				publication,
				controller.signal,
				this.diagnostics,
			);
			if (this.disposed) return;
			this.lastSignature = signature;
			this.managedPaneIds = publication.panes.map((card) => card.paneId);
			this.managedWorkspaceIds = publication.workspaces.map(
				(card) => card.workspaceId,
			);
			this.retainedRequiredPanes = retainedRequiredPaneIds(
				publication,
				this.retainedRequiredPanes,
			);
			this.lastObservations = live.observations;
		} catch (error) {
			this.diagnostics.report(
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/** Last read observations, exposed for tests and diagnostics. */
	get observations(): readonly SidebarObservation[] {
		return this.lastObservations;
	}

	/** Token names this owner clears when a managed association disappears. */
	static readonly ownedPaneTokens = SIDEBAR_ALL_PANE_TOKENS;
	static readonly ownedWorkspaceTokens = SIDEBAR_ALL_WORKSPACE_TOKENS;
	static readonly rankToken = SIDEBAR_PANE_TOKENS.rank;

	/**
	 * Explicit disable: clear the source-guarded view and the owned metadata,
	 * leaving native names, workflow stores, and other sources untouched.
	 */
	async disable(): Promise<void> {
		this.stopTimer();
		this.controller?.abort();
		try {
			await clearSidebarPresentation({
				herdr: this.options.herdr,
				views: this.options.views,
				// Panes and workspaces published in earlier refreshes may no longer
				// appear in the current views; their ids are still owned here.
				extraPaneIds: this.managedPaneIds,
				extraWorkspaceIds: this.managedWorkspaceIds,
				...(this.options.socketPath
					? { socketPath: this.options.socketPath }
					: {}),
			});
		} catch (error) {
			this.diagnostics.report(
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/**
	 * Ordinary disposal: cancel timers and in-flight socket work, finish only
	 * bounded in-flight publication, and leave the last published cards alone.
	 * Another live application keeps using the server-wide view.
	 */
	dispose(): void {
		this.disposed = true;
		this.pending = false;
		this.stopTimer();
		this.controller?.abort();
		this.controller = undefined;
	}
}
