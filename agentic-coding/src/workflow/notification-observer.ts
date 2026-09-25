// Application-owned developer-action notification lifecycle
// (workflow-developer-notifications).
//
// One owner per long-lived Agentic Coding application: on each bounded refresh
// it reads the governed workflow views plus one batched Herdr observation read,
// reduces each workflow to its owed state with the sidebar's own obligation
// semantics, and raises exactly one notification (plus dashboard focus) per
// false → true transition. Overlapping refreshes coalesce; disposal ends the
// timer. Nothing here drains the outbox, claims effects, or touches agent
// processes, and every failure is presentation-only.

import type { WorkflowView } from "../contracts/workflow.ts";
import type { HerdrPort } from "./adapters.ts";
import { herdrNotificationsEnabled } from "./effects.ts";
import {
	BoundedNotificationDiagnostics,
	type NotificationDiagnostics,
	raiseDeveloperNotification,
} from "./notification-sync.ts";
import {
	type DeveloperActionNotification,
	developerActionNotification,
	nextOwedState,
	workflowNotificationKey,
} from "./notifications.ts";
import {
	currentRunForPane,
	paneInputFacts,
	runRequiresDeveloperInput,
	type SidebarObservation,
	standaloneClassifications,
} from "./sidebar.ts";
import { readSidebarObservations } from "./sidebar-sync.ts";

/** Bounded fallback refresh, matching the sidebar owner's cadence. */
export const NOTIFICATION_FALLBACK_REFRESH_MS = 2_000;

/** Consecutive refreshes a workflow may be absent from the views before its
 * transition baseline is dropped. A grace window keeps a transient per-repo
 * view read failure from resetting every baseline, while still bounding the
 * map over a long session. */
export const OWED_STATE_MISSING_GRACE = 5;

export interface WorkflowNotificationsOptions {
	herdr: HerdrPort;
	/** Current authoritative views for the repositories this owner covers. */
	views: () => readonly WorkflowView[];
	diagnostics?: NotificationDiagnostics;
	refreshMs?: number;
	/** Trusted preference override; defaults to the user configuration. */
	enabled?: () => boolean;
}

/**
 * Reduce one view's live agent obligation exactly as the sidebar does: the
 * latest run per pane decides, a committed pending question or a fresh/retained
 * `blocked` observation requires input, and `nextRetained` records the panes
 * whose obligation must survive a failed next read.
 */
export function viewAgentRequiresInput(
	view: WorkflowView,
	observations: ReadonlyMap<string, SidebarObservation>,
	retainedRequired: ReadonlySet<string>,
	nextRetained: Set<string>,
	livePaneIds?: ReadonlySet<string>,
): boolean {
	const paneRuns = view.runs.filter(
		(run): run is (typeof view.runs)[number] & { paneId: string } =>
			typeof run.paneId === "string" && run.paneId.length > 0,
	);
	let requires = false;
	for (const paneId of new Set(paneRuns.map((run) => run.paneId))) {
		// Mirror `projectSidebar`: a pane that no longer exists in Herdr is
		// skipped instead of manufacturing an obligation the sidebar does not
		// show.
		if (!(livePaneIds?.has(paneId) ?? true)) continue;
		const run = currentRunForPane(paneRuns, paneId);
		if (!run) continue;
		const facts = paneInputFacts(
			runRequiresDeveloperInput(view, run.id),
			observations.get(paneId),
			retainedRequired.has(paneId),
		);
		if (facts.requiresInput) {
			requires = true;
			nextRetained.add(paneId);
		} else {
			nextRetained.delete(paneId);
		}
	}
	return requires;
}

/**
 * The long-lived notification owner. Started by the TUI shell while home/dash
 * is alive and disposed on shell teardown; no daemon survives disposal.
 */
export class WorkflowNotifications {
	private timer: ReturnType<typeof setInterval> | undefined;
	private controller: AbortController | undefined;
	private running: Promise<void> | undefined;
	private pending = false;
	private started = false;
	private disposed = false;
	private readonly owedStates = new Map<string, boolean>();
	private readonly owedMisses = new Map<string, number>();
	private retainedRequired: ReadonlySet<string> = new Set();
	private readonly diagnostics: NotificationDiagnostics;
	private readonly refreshMs: number;
	private readonly enabledFn: () => boolean;

	constructor(private readonly options: WorkflowNotificationsOptions) {
		this.diagnostics =
			options.diagnostics ?? new BoundedNotificationDiagnostics();
		this.refreshMs = options.refreshMs ?? NOTIFICATION_FALLBACK_REFRESH_MS;
		this.enabledFn = options.enabled ?? (() => herdrNotificationsEnabled());
	}

	/** Whether the trusted user preference enables this integration. */
	get enabled(): boolean {
		return this.enabledFn();
	}

	/** Start the bounded fallback refresh. Idempotent and disabled-safe. */
	start(): void {
		if (this.started || this.disposed || !this.enabled) return;
		this.started = true;
		this.timer = setInterval(() => void this.reconcile(), this.refreshMs);
	}

	/**
	 * Reconcile notifications. Overlapping triggers coalesce into one running
	 * refresh plus at most one follow-up, so a burst cannot raise duplicate
	 * notifications for the same transition.
	 */
	reconcile(): Promise<void> {
		if (this.disposed || !this.enabled) return Promise.resolve();
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
			// read cannot notify for an obsolete association.
			const views = this.options.views();
			const observations = new Map(
				live.observations.map((observation) => [
					observation.paneId,
					observation,
				]),
			);
			const nextRetained = new Set<string>();
			const livePaneIds = new Set(
				live.unmanagedPanes.map((pane) => pane.paneId),
			);
			const standalone = standaloneClassifications(views);
			const observed = new Set<string>();
			for (const view of views) {
				const key = workflowNotificationKey(view);
				observed.add(key);
				const agentRequiresInput = viewAgentRequiresInput(
					view,
					observations,
					this.retainedRequired,
					nextRetained,
					livePaneIds,
				);
				const notification = developerActionNotification(
					view,
					agentRequiresInput,
					standalone,
				);
				const transition = nextOwedState(
					this.owedStates.get(key),
					notification !== undefined,
				);
				this.owedStates.set(key, transition.state);
				this.owedMisses.delete(key);
				if (!transition.notify || !notification) continue;
				await this.raise(view, notification, controller.signal);
			}
			this.pruneAbsentOwedStates(observed);
			this.retainedRequired = nextRetained;
		} catch (error) {
			this.diagnostics.report(
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/** Drop baselines for workflows absent from several consecutive refreshes,
	 * bounding the map without resetting every baseline on one failed read. */
	private pruneAbsentOwedStates(observed: ReadonlySet<string>): void {
		for (const key of [...this.owedStates.keys()]) {
			if (observed.has(key)) continue;
			const misses = (this.owedMisses.get(key) ?? 0) + 1;
			if (misses >= OWED_STATE_MISSING_GRACE) {
				this.owedStates.delete(key);
				this.owedMisses.delete(key);
			} else {
				this.owedMisses.set(key, misses);
			}
		}
	}

	/**
	 * Raise one notification and focus the dashboard. Any delivery outcome
	 * counts as raised; a transport failure is one bounded diagnostic and skips
	 * the focus, and a failed focus never un-raises the notification.
	 */
	private async raise(
		view: WorkflowView,
		notification: DeveloperActionNotification,
		signal: AbortSignal,
	): Promise<void> {
		try {
			const result = await raiseDeveloperNotification(
				this.options.herdr,
				notification,
				view.workspace,
				signal,
			);
			if (!result.focused && view.workspace && !this.disposed)
				this.diagnostics.report(
					`dashboard focus skipped for workspace ${view.workspace}`,
				);
		} catch (error) {
			// A delivery transport failure is one bounded diagnostic; nothing is
			// retried and no workflow state changes.
			this.diagnostics.report(
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/** Ordinary disposal: cancel the timer and any in-flight refresh. */
	dispose(): void {
		this.disposed = true;
		this.pending = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.controller?.abort();
		this.controller = undefined;
	}
}
