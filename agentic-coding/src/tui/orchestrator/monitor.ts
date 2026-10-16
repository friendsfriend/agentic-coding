// Shell-owned workflow event delivery (add-orchestrator-event-subscriptions,
// task 4.2; formerly add-orchestrator-workflow-monitoring task 2.1/2.2).
//
// The server derives the catalog events from the one workflow each event names
// and publishes a delivery frame on its stream; the shell does the half that
// needs the durable host client: it raises the developer notification for the
// human-needed events and submits a subscribed note to the active orchestrator
// session. The shell reads no workflow view and derives no transition itself.
//
// Delivery is deliberately asymmetric:
//   * a human-needed event of a workflow the orchestrator started raises a
//     shell notification immediately, in `wake` and in `notify` mode;
//   * in `wake` mode a subscribed event becomes a note to the active session,
//     coalesced by the pure planner so a burst can never be a wake-up storm.
//
// `off` observes nothing at all: no subscription, no notification, no note.

import { decodeContract } from "../../contracts/decode.ts";
import type { EventEnvelope } from "../../contracts/environment.ts";
import type { DashboardGateway } from "../../contracts/gateway.ts";
import {
	describeWorkflowEvent,
	type WorkflowEventDeliveryFrame,
	workflowEventDeliveryFrameSchema,
} from "../../contracts/workflow-events.ts";
import { loadAgentConfig } from "../../server/config.ts";
import {
	DEFAULT_ORCHESTRATOR_MONITOR,
	type OrchestratorMonitorMode,
	orchestratorMonitorMode,
} from "../../workflow/profiles.ts";
import { gatewayOrUndefined } from "../data/index.ts";
import { notify as shellNotify } from "../otel/app/notifications.ts";
import { DELIVERY_TIMINGS, DeliveryPlanner } from "./delivery.ts";

/** How many times a resync may re-open the stream without an event arriving: a
 * cursor the server cannot satisfy must not become a resubscribe loop. */
const MAX_RESYNC_ATTEMPTS = 3;

export interface MonitorTimings {
	/** Events inside this window become one note. */
	readonly coalesceMs: number;
	/** At most one note per session in this interval; overflow merges forward. */
	readonly minNoteIntervalMs: number;
	/** A digest subscription's default accumulation window. */
	readonly digestMs: number;
}

/** The production cadence: 10 s of coalescing, one note per minute, a five
 * minute digest. The server debounces its own per-workflow read, so nothing here
 * waits on a read. */
export const MONITOR_TIMINGS: MonitorTimings = {
	coalesceMs: DELIVERY_TIMINGS.coalesceMs,
	minNoteIntervalMs: DELIVERY_TIMINGS.minNoteIntervalMs,
	digestMs: DELIVERY_TIMINGS.digestMs,
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
	/** Clock, so a test needs no sleep to reach a cadence boundary. */
	readonly now?: () => number;
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

/** The message a human-needed event shows: the workflow and the step it
 * reached, so the developer knows what to open. */
export function notificationFor(frame: WorkflowEventDeliveryFrame): string {
	return `${frame.event.workflowId}: ${describeWorkflowEvent(frame.event)} (${frame.event.stepId})`;
}

/** Decode one delivery frame off the shell's stream. A malformed payload is
 * dropped, never forwarded into a note. */
export function decodeDeliveryFrame(
	payload: unknown,
): WorkflowEventDeliveryFrame | undefined {
	try {
		return decodeContract<WorkflowEventDeliveryFrame>(
			"workflow-event.frame",
			workflowEventDeliveryFrameSchema,
			payload,
		);
	} catch {
		return undefined;
	}
}

export function startWorkflowMonitor(
	options: WorkflowMonitorOptions = {},
): WorkflowMonitor {
	const mode = options.mode ?? configuredMonitorMode();
	const gateway = options.gateway ?? gatewayOrUndefined();
	if (mode === "off" || !gateway) return { stop: () => {} };
	const timings: MonitorTimings = { ...MONITOR_TIMINGS, ...options.timings };
	const now = options.now ?? (() => Date.now());
	const notify =
		options.notify ?? ((message: string) => shellNotify(message, "warning"));
	const deliver = options.deliver ?? deliverToOrchestratorSession;
	const planner = new DeliveryPlanner({
		...DELIVERY_TIMINGS,
		coalesceMs: timings.coalesceMs,
		minNoteIntervalMs: timings.minNoteIntervalMs,
		digestMs: timings.digestMs,
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	/** The highest event sequence the shell has seen, and how many times a resync
	 * has re-opened the stream without an event arriving in between. */
	let lastSequence: number | undefined;
	let resyncAttempts = 0;
	/** Bumped per subscription, so a nested relink can tell which one won. */
	let generation = 0;
	let detach: () => void = () => {};

	const clearTimer = (): void => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};

	/** Send the note the planner says is due, then re-arm for whatever merged
	 * forward. A note that cannot be delivered is dropped, as before: the
	 * workflow's state is visible in the sidebar, and a retry loop would cost
	 * more than the note is worth. */
	const flush = (): void => {
		clearTimer();
		if (stopped) return;
		const note = planner.flush(now());
		if (note !== undefined)
			void deliver(note).catch(() => {
				/* best effort, exactly as before this change */
			});
		arm();
	};

	const arm = (): void => {
		if (stopped) return;
		clearTimer();
		const due = planner.nextDueAt(now());
		if (due === undefined) return;
		timer = setTimeout(flush, Math.max(0, due - now()));
	};

	const record = (frame: WorkflowEventDeliveryFrame): void => {
		// The developer notification is independent of every subscription and of
		// the mode (except `off`, which never starts this monitor), so it is
		// raised before anything is queued.
		if (frame.event.humanNeeded && frame.event.startedBy === "orchestrator")
			notify(notificationFor(frame));
		if (mode !== "wake") return;
		planner.record(frame.event, frame.subscriptions, now());
		arm();
	};

	const streamHandlers = {
		onEvent: (event: EventEnvelope) => {
			if (stopped || event.domain !== "workflow-event") return;
			// The highest sequence the shell has seen: the cursor a resync re-opens
			// from, so an overflow of the transport queue costs a replay instead of
			// silence.
			lastSequence = event.sequence;
			resyncAttempts = 0;
			const frame = decodeDeliveryFrame(event.payload);
			if (frame) record(frame);
		},
		onResync: () => {
			// A resync is reported for an overflow of the transport queue as well as
			// for a genuine cursor gap. The pending events stay (they are already
			// scheduled with their own due times) and the stream is re-opened from
			// the last sequence the shell saw, so everything the server still
			// retains after it is replayed; a genuine gap is answered by the
			// server's own log through `read_events`. Bounded, so a server that
			// cannot satisfy the cursor is not asked in a loop.
			if (stopped) return;
			arm();
			if (lastSequence === undefined || resyncAttempts >= MAX_RESYNC_ATTEMPTS)
				return;
			resyncAttempts += 1;
			relink(lastSequence);
		},
	};

	// Captured after the `off`/undefined guard: a hoisted function declaration does
	// not inherit that narrowing, and `relink` needs a definitely-defined gateway.
	const stream = gateway;

	/** Re-open the stream from a cursor: `gateway.subscribe` replays everything
	 * the server still retains after it. The old handle is cleared *before* the
	 * new subscription exists, so a resync delivered synchronously inside
	 * `subscribe` detaches a placeholder instead of the live subscription. */
	const relink = (after: number): void => {
		const mine = ++generation;
		const previous = detach;
		detach = () => {};
		previous();
		const next = stream.subscribe(streamHandlers, after);
		// A resync delivered synchronously inside `subscribe` re-enters this
		// function: that nested call owns the newest subscription, so this frame
		// closes the one it just opened instead of leaving it live.
		if (generation !== mine) {
			next();
			return;
		}
		detach = next;
	};

	detach = stream.subscribe(streamHandlers);

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			detach();
			clearTimer();
			planner.reset();
		},
	};
}
