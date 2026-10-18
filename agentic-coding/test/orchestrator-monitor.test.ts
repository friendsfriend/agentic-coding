// Workflow event delivery: the pure planner and the shell monitor
// (add-orchestrator-event-subscriptions, tasks 4.1-4.3). The planner is
// exercised with an explicit clock; the monitor with an injected gateway, so
// neither depends on a real wait for a cadence boundary.
import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../src/contracts/environment.ts";
import type {
	DashboardGateway,
	GatewayEventHandlers,
} from "../src/contracts/gateway.ts";
import type {
	WorkflowEventDeliveryMatch,
	WorkflowEventRecord,
	WorkflowEventSeverity,
} from "../src/contracts/workflow-events.ts";
import { MAX_NOTE_LINES } from "../src/contracts/workflow-events.ts";
import {
	DELIVERY_TIMINGS,
	DeliveryPlanner,
	formatNote,
} from "../src/tui/orchestrator/delivery.ts";
import {
	MONITOR_TIMINGS,
	startWorkflowMonitor,
} from "../src/tui/orchestrator/monitor.ts";

function event(
	overrides: Partial<WorkflowEventRecord> = {},
): WorkflowEventRecord {
	return {
		sequence: 1,
		id: "review.waiting",
		repository: "/repo",
		workflowId: "wf-1",
		startedBy: "orchestrator",
		stepId: "core.developer-review",
		stepLabel: "core.developer-review",
		severity: "warning" as WorkflowEventSeverity,
		humanNeeded: true,
		at: "2026-01-01T00:00:00.000Z",
		payload: {
			review: "developer",
			stepId: "core.developer-review",
			stepLabel: "core.developer-review",
		},
		...overrides,
	};
}

const subscription = (
	label: string,
	mode: WorkflowEventDeliveryMatch["mode"] = "wake",
): WorkflowEventDeliveryMatch & {
	coalesceMs?: number;
	digestMinutes?: number;
} => ({
	id: `sub-${label}`,
	label,
	mode,
});

const EMPTY = { ...DELIVERY_TIMINGS, maxBacklog: 200 };

describe("delivery planner", () => {
	test("events inside the coalescing window become one note", () => {
		const planner = new DeliveryPlanner({
			...EMPTY,
			coalesceMs: 10,
			minNoteIntervalMs: 0,
		});
		planner.record(event({ sequence: 1 }), [subscription("default")], 0);
		planner.record(
			event({ sequence: 2, workflowId: "wf-2" }),
			[subscription("default")],
			0,
		);
		expect(planner.flush(5)).toBeUndefined();
		const note = planner.flush(10);
		expect(note?.split("\n")).toHaveLength(3);
		expect(note?.startsWith("[workflow-monitor] subs=default\n")).toBe(true);
		expect(planner.pendingCount).toBe(0);
	});

	test("one event matched by two subscriptions is one line naming both labels", () => {
		const planner = new DeliveryPlanner({
			...EMPTY,
			coalesceMs: 0,
			minNoteIntervalMs: 0,
		});
		planner.record(
			event({ sequence: 7 }),
			[subscription("default"), subscription("awaiting-review")],
			0,
		);
		const note = planner.flush(0);
		expect(note?.split("\n")).toHaveLength(2);
		expect(note).toContain("subs=default,awaiting-review");
	});

	test("the per-minute bound merges overflow forward", () => {
		const planner = new DeliveryPlanner({
			...EMPTY,
			coalesceMs: 0,
			minNoteIntervalMs: 60_000,
		});
		planner.record(event({ sequence: 1 }), [subscription("default")], 0);
		expect(planner.flush(0)).toContain("wf-1");
		planner.record(
			event({ sequence: 2, workflowId: "wf-2" }),
			[subscription("default")],
			1,
		);
		expect(planner.flush(1)).toBeUndefined();
		expect(planner.pendingCount).toBe(1);
		expect(planner.nextDueAt(1)).toBe(60_000);
		expect(planner.flush(60_000)).toContain("wf-2");
	});

	test("a digest subscription accumulates to its own interval", () => {
		const planner = new DeliveryPlanner({ ...EMPTY, digestMs: 300_000 });
		planner.record(
			event({ sequence: 1 }),
			[subscription("digest", "digest")],
			0,
		);
		planner.record(
			event({ sequence: 2 }),
			[subscription("digest", "digest")],
			0,
		);
		expect(planner.flush(120_000)).toBeUndefined();
		const note = planner.flush(300_000);
		expect(note?.split("\n")).toHaveLength(3);
	});

	test("a subscription's own digestMinutes overrides the default window", () => {
		const planner = new DeliveryPlanner({ ...EMPTY, digestMs: 300_000 });
		planner.record(
			event({ sequence: 1 }),
			[{ ...subscription("digest", "digest"), digestMinutes: 1 }],
			0,
		);
		expect(planner.flush(30_000)).toBeUndefined();
		expect(planner.flush(60_000)).toContain("wf-1");
	});

	test("a subscription's own minIntervalMs floors how soon it contributes again", () => {
		const planner = new DeliveryPlanner({
			...EMPTY,
			coalesceMs: 0,
			minNoteIntervalMs: 0,
		});
		const patient = { ...subscription("patient"), minIntervalMs: 120_000 };
		planner.record(event({ sequence: 1 }), [patient], 0);
		expect(planner.flush(0)).toContain("wf-1");
		planner.record(event({ sequence: 2, workflowId: "wf-2" }), [patient], 1);
		expect(planner.flush(1)).toBeUndefined();
		expect(planner.nextDueAt(1)).toBe(120_000);
		expect(planner.flush(120_000)).toContain("wf-2");
	});

	test("a silent-only match is never delivered", () => {
		const planner = new DeliveryPlanner(EMPTY);
		planner.record(event(), [subscription("silent", "silent")], 0);
		expect(planner.pendingCount).toBe(0);
		expect(planner.flush(10_000)).toBeUndefined();
	});

	test("a note elides past the line bound, and the backlog drops the oldest", () => {
		const planner = new DeliveryPlanner({
			...EMPTY,
			coalesceMs: 0,
			minNoteIntervalMs: 0,
			maxNoteLines: 2,
			maxBacklog: 4,
		});
		for (let index = 1; index <= 6; index += 1)
			planner.record(event({ sequence: index }), [subscription("default")], 0);
		const note = planner.flush(0);
		const lines = note?.split("\n") ?? [];
		expect(lines).toHaveLength(4);
		expect(lines[3]).toBe("… +4 more");
	});

	test("the hard note cap keeps the rest queued", () => {
		const planner = new DeliveryPlanner({
			...EMPTY,
			coalesceMs: 0,
			minNoteIntervalMs: 0,
			maxNotesPerHour: 1,
		});
		planner.record(event({ sequence: 1 }), [subscription("default")], 0);
		expect(planner.flush(0)).toBeDefined();
		planner.record(event({ sequence: 2 }), [subscription("default")], 1);
		expect(planner.flush(1)).toBeUndefined();
		expect(planner.nextDueAt(1)).toBe(60 * 60 * 1000);
		expect(planner.flush(60 * 60 * 1000)).toBeDefined();
	});

	test("a storm is one note, capped at the line bound with an exact remainder", () => {
		const planner = new DeliveryPlanner({
			...DELIVERY_TIMINGS,
			coalesceMs: 0,
			minNoteIntervalMs: 0,
		});
		// The shape of the bug this cap defends against: thousands of events for
		// one workflow inside one window. The note may never grow with them.
		for (let sequence = 1; sequence <= 1_000; sequence += 1)
			planner.record(
				event({ sequence, workflowId: "wf-1" }),
				[subscription("default")],
				0,
			);
		const note = planner.flush(0);
		const lines = note?.split("\n") ?? [];
		expect(lines).toHaveLength(MAX_NOTE_LINES + 2);
		expect(lines[0]).toBe("[workflow-monitor] subs=default");
		expect(lines.at(-1)).toBe(`… +${1_000 - MAX_NOTE_LINES} more`);
		// Everything past the cap was dropped from the note, not left queued to
		// arrive as a second one.
		expect(planner.pendingCount).toBe(0);
		expect(planner.flush(60_000)).toBeUndefined();
	});

	test("a window carries every event that arrived inside it, not only the ones due at its close", () => {
		const planner = new DeliveryPlanner({
			...EMPTY,
			coalesceMs: 5,
			minNoteIntervalMs: 60_000,
		});
		// The shape of the flake this pins down: a burst the monitor records over a
		// few milliseconds used to open one window per millisecond, so the note the
		// first window produced carried only its own millisecond and everything else
		// the window received waited a whole `minNoteIntervalMs` for the next note.
		for (const at of [0, 1, 2, 3])
			planner.record(
				event({ sequence: at + 1 }),
				[subscription("default")],
				at,
			);
		expect(planner.flush(5)?.split("\n")).toHaveLength(5);
		expect(planner.pendingCount).toBe(0);
		expect(planner.flush(65_000)).toBeUndefined();
	});

	test("formatNote names no label when nothing matched", () => {
		expect(
			formatNote(
				[
					{
						event: event({}),
						labels: [],
						dueAt: 0,
					},
				],
				EMPTY,
			),
		).toBe(
			"[workflow-monitor]\n- wf-1 → core.developer-review (developer review waiting)",
		);
	});
});

/** The slice of the gateway port the monitor uses. */
class FakeGateway {
	handlers: GatewayEventHandlers | undefined;
	subscribes = 0;
	unsubscribes = 0;
	/** Subscriptions that are open right now. */
	live = 0;
	/** Report an unsatisfiable cursor synchronously from inside `subscribe`,
	 * exactly as the in-process adapter does. */
	resyncOnCursor = false;

	subscribe(handlers: GatewayEventHandlers, cursor?: number): () => void {
		this.subscribes += 1;
		this.handlers = handlers;
		this.live += 1;
		if (cursor !== undefined && this.resyncOnCursor)
			handlers.onResync("cursor outside the retained event window");
		return () => {
			this.unsubscribes += 1;
			this.live -= 1;
			if (this.handlers === handlers) this.handlers = undefined;
		};
	}

	frame(payload: unknown): void {
		this.handlers?.onEvent({
			instance: "test",
			sequence: 1,
			domain: "workflow-event",
			kind: "event",
			at: new Date().toISOString(),
			payload,
		} satisfies EventEnvelope);
	}

	resync(): void {
		this.handlers?.onResync("gap");
	}
}

async function waitUntil(
	condition: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !condition()) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FAST = { coalesceMs: 10, minNoteIntervalMs: 60, digestMs: 30 };

function harness(
	options: {
		mode?: "wake" | "notify" | "off";
		timings?: Partial<typeof FAST>;
		/** An injected clock the caller advances, so a burst can be recorded in one
		 * instant and its window closed deliberately instead of by racing it. */
		clock?: { at: number };
	} = {},
) {
	const gateway = new FakeGateway();
	const notes: string[] = [];
	const notifications: string[] = [];
	const monitor = startWorkflowMonitor({
		gateway: gateway as unknown as DashboardGateway,
		mode: options.mode ?? "wake",
		timings: { ...FAST, ...options.timings },
		...(options.clock ? { now: () => options.clock?.at ?? 0 } : {}),
		notify: (message) => notifications.push(message),
		deliver: async (note) => {
			notes.push(note);
		},
	});
	return { gateway, notes, notifications, monitor };
}

describe("monitor delivery", () => {
	test("off observes nothing at all", () => {
		const { gateway, notes, notifications, monitor } = harness({ mode: "off" });
		expect(gateway.subscribes).toBe(0);
		expect(notes).toEqual([]);
		expect(notifications).toEqual([]);
		monitor.stop();
	});

	test("the production cadence is the designed one", () => {
		expect(MONITOR_TIMINGS.coalesceMs).toBe(10_000);
		expect(MONITOR_TIMINGS.minNoteIntervalMs).toBe(60_000);
		expect(MONITOR_TIMINGS.digestMs).toBe(5 * 60_000);
	});

	test("stop unsubscribes and drops a pending note", async () => {
		const { gateway, notes, monitor } = harness();
		gateway.frame({
			event: event({ sequence: 1 }),
			subscriptions: [subscription("default")],
		});
		monitor.stop();
		expect(gateway.unsubscribes).toBe(1);
		await sleep(40);
		expect(notes).toEqual([]);
	});

	test("a burst coalesces into one note, and a human-needed event notifies once per workflow", async () => {
		// An injected clock: all three frames are recorded in one instant, and the
		// window is closed by advancing the clock rather than by racing it.
		const clock = { at: 0 };
		const { gateway, notes, notifications, monitor } = harness({
			timings: { coalesceMs: 10, minNoteIntervalMs: 0 },
			clock,
		});
		for (const [index, id] of ["wf-1", "wf-2", "wf-3"].entries())
			gateway.frame({
				event: event({ sequence: index + 1, workflowId: id }),
				subscriptions: [subscription("default")],
			});
		await sleep(30);
		expect(notes).toEqual([]);
		clock.at = 10;
		await waitUntil(() => notes.length === 1);
		expect(notes).toHaveLength(1);
		const lines = (notes[0] ?? "").split("\n");
		expect(lines[0]).toBe("[workflow-monitor] subs=default");
		expect(lines).toHaveLength(4);
		for (const id of ["wf-1", "wf-2", "wf-3"]) expect(notes[0]).toContain(id);
		expect(notifications).toEqual([
			"wf-1: developer review waiting (core.developer-review)",
			"wf-2: developer review waiting (core.developer-review)",
			"wf-3: developer review waiting (core.developer-review)",
		]);
		monitor.stop();
	});

	test("today's default delivery is the golden note", async () => {
		const { gateway, notes, monitor } = harness();
		gateway.frame({
			event: event({
				id: "workflow.completed",
				humanNeeded: false,
				severity: "info",
				stepId: "core.completed",
				payload: { stepId: "core.completed", stepLabel: "core.completed" },
			}),
			subscriptions: [subscription("default")],
		});
		await waitUntil(() => notes.length === 1);
		expect(notes[0]).toBe(
			"[workflow-monitor] subs=default\n- wf-1 → core.completed (completed)",
		);
		monitor.stop();
	});

	test("a silent subscription delivers no note but still notifies on a human-needed event", async () => {
		const { gateway, notes, notifications, monitor } = harness();
		gateway.frame({
			event: event({ sequence: 1 }),
			subscriptions: [subscription("quiet", "silent")],
		});
		await sleep(40);
		expect(notes).toEqual([]);
		expect(notifications).toHaveLength(1);
		monitor.stop();
	});

	test("a developer-started workflow never notifies", async () => {
		const { gateway, notes, notifications, monitor } = harness();
		gateway.frame({
			event: event({ startedBy: "developer" }),
			subscriptions: [subscription("default")],
		});
		await waitUntil(() => notes.length === 1);
		expect(notifications).toEqual([]);
		monitor.stop();
	});

	test("a frame without a matching subscription delivers nothing", async () => {
		const { gateway, notes, monitor } = harness();
		gateway.frame({ event: event(), subscriptions: [] });
		await sleep(40);
		expect(notes).toEqual([]);
		monitor.stop();
	});

	test("a malformed frame is dropped, never delivered", async () => {
		const { gateway, notes, monitor } = harness();
		gateway.frame({ event: { id: "review.waiting" }, subscriptions: [] });
		await sleep(40);
		expect(notes).toEqual([]);
		monitor.stop();
	});

	test("notify mode notifies but never submits input", async () => {
		const { gateway, notes, notifications, monitor } = harness({
			mode: "notify",
		});
		gateway.frame({
			event: event({
				id: "attention.raised",
				humanNeeded: false,
				payload: { reasons: ["boom"] },
			}),
			subscriptions: [subscription("default")],
		});
		await sleep(40);
		expect(notes).toEqual([]);
		expect(notifications).toEqual([]);
		gateway.frame({
			event: event({ sequence: 2 }),
			subscriptions: [subscription("default")],
		});
		await waitUntil(() => notifications.length === 1);
		expect(notes).toEqual([]);
		monitor.stop();
	});

	test("a resync keeps the pending backlog and still delivers it", async () => {
		// A resync is reported for a transport overflow as well as for a genuine
		// gap, and the events are already scheduled with their own due times: the
		// backlog is kept rather than thrown away.
		const { gateway, notes, monitor } = harness({
			timings: { coalesceMs: 60, minNoteIntervalMs: 0 },
		});
		gateway.frame({
			event: event({ sequence: 1 }),
			subscriptions: [subscription("default")],
		});
		gateway.resync();
		await waitUntil(() => notes.length === 1);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("wf-1");
		monitor.stop();
	});

	test("a resync delivered inside subscribe leaves exactly one live subscription", async () => {
		const { gateway, notifications, monitor } = harness();
		gateway.resyncOnCursor = true;
		gateway.frame({
			event: event({ sequence: 1 }),
			subscriptions: [subscription("default")],
		});
		for (let attempt = 0; attempt < 5; attempt += 1) gateway.resync();
		await sleep(50);
		expect(gateway.live).toBe(1);
		expect(notifications).toHaveLength(1);
		monitor.stop();
		expect(gateway.live).toBe(0);
	});

	test("a subscription's own coalescing window travels on the frame", async () => {
		const { gateway, notes, monitor } = harness({
			timings: { coalesceMs: 5, minNoteIntervalMs: 0 },
		});
		gateway.frame({
			event: event({ sequence: 1 }),
			subscriptions: [{ ...subscription("patient"), coalesceMs: 300 }],
		});
		await sleep(80);
		expect(notes).toEqual([]);
		await waitUntil(() => notes.length === 1);
		expect(notes).toHaveLength(1);
		monitor.stop();
	});

	test("a storm is one note, and the next note waits for the minimum interval", async () => {
		// An injected clock, as in the burst test above: the whole storm is recorded
		// inside one coalescing window and the window is closed by advancing the
		// clock, so the note's contents do not depend on how long the 200 synchronous
		// frames take or on which millisecond each one lands in. The arrival-time
		// split itself is the planner's own test ("a window carries every event that
		// arrived inside it").
		const clock = { at: 0 };
		const { gateway, notes, monitor } = harness({
			timings: { coalesceMs: 5, minNoteIntervalMs: 100 },
			clock,
		});
		const storm = (from: number): void => {
			for (let sequence = from; sequence < from + 200; sequence += 1)
				gateway.frame({
					event: event({
						sequence,
						id: "attention.raised",
						humanNeeded: false,
						payload: { reasons: ["boom"] },
					}),
					subscriptions: [subscription("default")],
				});
		};
		// 200 events for one workflow inside one coalescing window: one note, and
		// never more than the line bound in it.
		storm(1);
		await sleep(20);
		expect(notes).toEqual([]);
		// The window closes.
		clock.at = 5;
		await waitUntil(() => notes.length === 1);
		expect(notes[0]?.split("\n")).toHaveLength(MAX_NOTE_LINES + 2);
		// 400 more inside the minimum interval: the session is not woken again.
		storm(201);
		storm(401);
		await sleep(40);
		expect(notes).toHaveLength(1);
		// Past the interval they merge forward into exactly one more capped note.
		clock.at = 105;
		await waitUntil(() => notes.length === 2);
		await sleep(40);
		expect(notes).toHaveLength(2);
		expect(notes[1]?.split("\n").length).toBeLessThanOrEqual(
			MAX_NOTE_LINES + 2,
		);
		monitor.stop();
	});

	test("a burst beyond the per-minute bound merges into the next note", async () => {
		const { gateway, notes, monitor } = harness({
			timings: { coalesceMs: 5, minNoteIntervalMs: 80 },
		});
		gateway.frame({
			event: event({ sequence: 1 }),
			subscriptions: [subscription("default")],
		});
		await waitUntil(() => notes.length === 1);
		gateway.frame({
			event: event({
				sequence: 2,
				id: "attention.raised",
				humanNeeded: false,
				payload: { reasons: ["boom"] },
			}),
			subscriptions: [subscription("default")],
		});
		await sleep(40);
		expect(notes).toHaveLength(1);
		gateway.frame({
			event: event({
				sequence: 3,
				id: "workflow.completed",
				humanNeeded: false,
				severity: "info",
				stepId: "core.completed",
				payload: { stepId: "core.completed", stepLabel: "core.completed" },
			}),
			subscriptions: [subscription("default")],
		});
		await waitUntil(() => notes.length === 2);
		expect(notes[1]?.split("\n")).toHaveLength(3);
		expect(notes[1]).toContain("attention required: boom");
		expect(notes[1]).toContain("completed");
		monitor.stop();
	});
});
