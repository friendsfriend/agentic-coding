// Shell-owned workflow monitor (add-orchestrator-workflow-monitoring, task 2.1
// and 2.2).
//
// The server publishes `workflow.*` events on its bounded stream; events carry
// only a repository and a workflow id, so the monitor re-reads that one
// workflow (debounced per workflow) and diffs the projection the pure detector
// owns. Only workflows the orchestrator started are observed: the monitor is the
// orchestrator's ears, not a second dashboard.
//
// Delivery is deliberately asymmetric:
//   * a transition that owes the developer a decision raises a shell
//     notification immediately, in `wake` and in `notify` mode;
//   * in `wake` mode every transition also becomes a note to the active
//     orchestrator session. Notes are coalesced into one 10 s window and the
//     session receives at most one per minute, with overflow merged forward, so
//     a burst of workflow state can never become a wake-up storm.
//
// `off` observes nothing at all: no subscription, no reads, no notifications.
import type { DashboardGateway } from "../../contracts/gateway.ts";
import type { WorkflowView } from "../../contracts/workflow.ts";
import { loadAgentConfig } from "../../server/config.ts";
import {
	DEFAULT_ORCHESTRATOR_MONITOR,
	type OrchestratorMonitorMode,
	orchestratorMonitorMode,
} from "../../workflow/profiles.ts";
import { gatewayOrUndefined } from "../data/index.ts";
import { notify as shellNotify } from "../otel/app/notifications.ts";
import {
	describeTransition,
	detectTransitions,
	formatMonitorNote,
	isHumanNeeded,
	projectWorkflow,
	type WorkflowProjection,
	type WorkflowTransition,
} from "./transitions.ts";

export interface MonitorTimings {
	/** Per-workflow debounce: repeated events for one workflow collapse into one
	 * re-read. */
	readonly debounceMs: number;
	/** Transitions inside this window become one note. */
	readonly coalesceMs: number;
	/** At most one note per session in this interval; overflow merges forward. */
	readonly minNoteIntervalMs: number;
}

/** The production cadence: 10 s of coalescing, one note per minute. The
 * debounce is short enough that an approval the developer is waiting to see
 * reported is never held. */
export const MONITOR_TIMINGS: MonitorTimings = {
	debounceMs: 250,
	coalesceMs: 10_000,
	minNoteIntervalMs: 60_000,
};

export interface WorkflowMonitorOptions {
	/** The transport to read through. Defaults to the installed gateway. */
	readonly gateway?: DashboardGateway;
	/** Effective mode. Defaults to the configured `[agents.orchestrator] monitor`. */
	readonly mode?: OrchestratorMonitorMode;
	/** Raise one shell notification. Defaults to the shell's own notification
	 * surface (the toast the observability/Home shell renders). */
	readonly notify?: (message: string) => void;
	/** Deliver one coalesced note to the active session. Defaults to the durable
	 * orchestrator host, which is ensured on first use. */
	readonly deliver?: (note: string) => Promise<void>;
	/** Timings; tests shorten the windows. */
	readonly timings?: Partial<MonitorTimings>;
}

export interface WorkflowMonitor {
	/** Stop observing and drop every pending note. Idempotent. */
	stop(): void;
}

/** The configured monitor mode, read from the layered `[agents.orchestrator]`
 * table. The monitor is a convenience, never a startup failure: an unreadable
 * configuration keeps the default `wake` and reports itself through the shell's
 * own configuration diagnostics. */
export function configuredMonitorMode(): OrchestratorMonitorMode {
	try {
		return orchestratorMonitorMode(loadAgentConfig().agents);
	} catch {
		return DEFAULT_ORCHESTRATOR_MONITOR;
	}
}

/** Ensure the orchestrator host (without opening the page) and submit one
 * follow-up note to the active session. Loaded lazily: the monitor is wired
 * into the shell's module graph, and the host client is only needed once a
 * note actually has to be delivered. */
async function deliverToOrchestratorSession(note: string): Promise<void> {
	const [{ openOrchestratorSession }, { HostClient }] = await Promise.all([
		import("./session.ts"),
		import("../../agent-host/client.ts"),
	]);
	const session = await openOrchestratorSession();
	const client = new HostClient(session.hostSocket);
	await client.submit(session.runId, note, crypto.randomUUID(), "followUp");
}

/** The message a human-needed transition shows: the workflow and the step it
 * reached, so the developer knows what to open. */
export function notificationFor(transition: WorkflowTransition): string {
	return `${transition.workflowId}: ${describeTransition(transition)} (${transition.stepId})`;
}

export function startWorkflowMonitor(
	options: WorkflowMonitorOptions = {},
): WorkflowMonitor {
	const mode = options.mode ?? configuredMonitorMode();
	const gateway = options.gateway ?? gatewayOrUndefined();
	if (mode === "off" || !gateway) return { stop: () => {} };
	const timings: MonitorTimings = { ...MONITOR_TIMINGS, ...options.timings };
	const notify =
		options.notify ?? ((message: string) => shellNotify(message, "warning"));
	const deliver = options.deliver ?? deliverToOrchestratorSession;

	/** Last projection per workflow, keyed by repository + workflow id. Absent
	 * means the next observation is that workflow's baseline. */
	const projections = new Map<string, WorkflowProjection>();
	/** The orchestrator-started workflows of each repository the monitor read. */
	const tracked = new Map<string, Set<string>>();
	/** Repositories an event has named: the set a `resync` re-reads. */
	const repos = new Set<string>();
	const readTimers = new Map<string, ReturnType<typeof setTimeout>>();

	let pending: WorkflowTransition[] = [];
	let noteTimer: ReturnType<typeof setTimeout> | undefined;
	let lastNoteAt = 0;
	let stopped = false;

	const keyOf = (repo: string, workflowId: string): string =>
		`${repo}\u0000${workflowId}`;

	const armNote = (delayMs: number): void => {
		noteTimer = setTimeout(() => {
			noteTimer = undefined;
			flushNote();
		}, delayMs);
	};

	/** Send the pending transitions as one note, or merge them into the next one
	 * when the per-minute bound has not elapsed yet. */
	const flushNote = (): void => {
		if (pending.length === 0) return;
		const now = Date.now();
		const wait = timings.minNoteIntervalMs - (now - lastNoteAt);
		if (wait > 0) {
			armNote(wait);
			return;
		}
		const note = formatMonitorNote(pending);
		pending = [];
		lastNoteAt = now;
		void deliver(note).catch(() => {
			// A wake-up that could not be delivered is never retried: the developer
			// still sees the workflow's state in the sidebar, and a retry loop would
			// cost more than the note is worth.
		});
	};

	/** Notify the developer and queue the note, in that order: the notification
	 * is independent of the mode and of whether the session can be reached. */
	const record = (transitions: readonly WorkflowTransition[]): void => {
		for (const transition of transitions)
			if (isHumanNeeded(transition.kind)) notify(notificationFor(transition));
		if (mode !== "wake") return;
		pending = [...pending, ...transitions];
		if (noteTimer === undefined) armNote(timings.coalesceMs);
	};

	const applyView = (repo: string, view: WorkflowView): void => {
		const workflowId = view.workflowId;
		if (!workflowId) return;
		const key = keyOf(repo, workflowId);
		if (view.startedBy !== "orchestrator") {
			// Not the orchestrator's work: keep no baseline.
			projections.delete(key);
			tracked.get(repo)?.delete(workflowId);
			return;
		}
		let ids = tracked.get(repo);
		if (!ids) {
			ids = new Set();
			tracked.set(repo, ids);
		}
		ids.add(workflowId);
		const next = projectWorkflow(view);
		const previous = projections.get(key);
		projections.set(key, next);
		const transitions = detectTransitions(previous, next, workflowId);
		if (transitions.length > 0) record(transitions);
	};

	const readOne = async (repo: string, workflowId: string): Promise<void> => {
		let view: WorkflowView;
		try {
			view = await gateway.view(repo, workflowId);
		} catch {
			// A read that failed keeps the previous projection: the next event or
			// resync re-reads it, and a transition is never invented from a miss.
			return;
		}
		if (stopped) return;
		applyView(repo, view);
	};

	/** A gap means events were missed, so re-read the authoritative list of each
	 * repository the monitor has seen and rebuild the orchestrator-started set. */
	const readRepo = async (repo: string): Promise<void> => {
		let views: readonly WorkflowView[];
		try {
			views = await gateway.listViews(repo);
		} catch {
			return;
		}
		if (stopped) return;
		const seen = new Set<string>();
		for (const view of views) {
			if (view.startedBy !== "orchestrator") continue;
			if (!view.workflowId) continue;
			seen.add(view.workflowId);
			applyView(repo, view);
		}
		// A workflow the store no longer lists is gone: drop its baseline so a
		// re-created id starts from its own first observation.
		const ids = tracked.get(repo);
		if (!ids) return;
		for (const workflowId of [...ids])
			if (!seen.has(workflowId)) {
				ids.delete(workflowId);
				projections.delete(keyOf(repo, workflowId));
			}
	};

	/** Debounce one workflow's re-read: a streaming workflow produced many
	 * `workflow.updated` events per second, and each is one event, not one read. */
	const schedule = (repo: string, workflowId: string): void => {
		repos.add(repo);
		const key = keyOf(repo, workflowId);
		const existing = readTimers.get(key);
		if (existing !== undefined) clearTimeout(existing);
		readTimers.set(
			key,
			setTimeout(() => {
				readTimers.delete(key);
				void readOne(repo, workflowId);
			}, timings.debounceMs),
		);
	};

	const unsubscribe = gateway.subscribe({
		onEvent: (event) => {
			if (stopped || event.domain !== "workflow") return;
			if (!event.resource || !event.runId) return;
			schedule(event.resource, event.runId);
		},
		onResync: () => {
			if (stopped) return;
			for (const repo of repos) void readRepo(repo);
		},
	});

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			unsubscribe();
			for (const timer of readTimers.values()) clearTimeout(timer);
			readTimers.clear();
			if (noteTimer !== undefined) clearTimeout(noteTimer);
			noteTimer = undefined;
			pending = [];
		},
	};
}
