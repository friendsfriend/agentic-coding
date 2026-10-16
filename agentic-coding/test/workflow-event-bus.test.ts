// Workflow event bus: bounded log, subscription store, derivation driver and
// delivery frames (add-orchestrator-event-subscriptions, tasks 2.1-2.5).
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import {
	MAX_EVENT_SUBSCRIPTIONS,
	type WorkflowEventDeliveryFrame,
} from "../src/contracts/workflow-events.ts";
import { saveOrchestratorSessionName } from "../src/orchestrator-state.ts";
import { EventBroker } from "../src/server/events.ts";
import {
	createWorkflowEventBus,
	MonitorOffError,
	StoreUnreadableError,
	SubscriptionLimitError,
	UnknownSessionError,
	UnknownWorkflowError,
	type WorkflowEventBus,
} from "../src/server/workflow-event-bus.ts";
import { matchesSubscriptionFilter } from "../src/server/workflow-events.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
	readonly bus: WorkflowEventBus;
	readonly broker: EventBroker;
	readonly views: Map<string, WorkflowView>;
	readonly reads: string[];
	readonly frames: WorkflowEventDeliveryFrame[];
	readonly runtimeDir: string;
	readonly listing: (repo: string) => readonly WorkflowView[];
	clock: number;
	mode: "wake" | "notify" | "off";
}

function view(
	workflowId: string,
	overrides: {
		status?: WorkflowView["status"];
		step?: string;
		startedBy?: WorkflowView["startedBy"];
		task?: string;
		attention?: string[];
	} = {},
): WorkflowView {
	const step = overrides.step ?? "core.implementation";
	return {
		workflowId,
		changeId: "a-change",
		status: overrides.status ?? "active",
		startedBy: overrides.startedBy ?? "orchestrator",
		task: overrides.task ?? "add a feature",
		currentStep: { id: step, label: step, attempt: 1, enteredAt: "" },
		runs: [],
		effects: [],
		health: { valid: true, attention: overrides.attention ?? [] },
		availableActions: [],
	} as unknown as WorkflowView;
}

function harness(
	options: {
		mode?: "wake" | "notify" | "off";
		capacity?: number;
		chargeFlushMs?: number;
	} = {},
): Harness {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-events-"));
	const broker = new EventBroker("test");
	const views = new Map<string, WorkflowView>();
	const reads: string[] = [];
	const frames: WorkflowEventDeliveryFrame[] = [];
	const state = {
		clock: Date.parse("2026-01-01T00:00:00.000Z"),
		mode: options.mode ?? "wake",
		stallMinutes: 30,
	} as Harness & { stallMinutes: number };
	broker.open({}, (event) => {
		if (event.domain === "workflow-event" && event.payload)
			frames.push(event.payload as WorkflowEventDeliveryFrame);
	});
	const bus = createWorkflowEventBus({
		events: broker,
		view: (repository, workflowId) => {
			reads.push(`${repository}\u0000${workflowId}`);
			const found = views.get(`${repository}\u0000${workflowId}`);
			if (!found) throw new Error("no such workflow");
			return found;
		},
		listViews: (repository) =>
			[...views.entries()]
				.filter(([key]) => key.startsWith(`${repository}\u0000`))
				.map(([, value]) => value),
		monitorMode: () => state.mode,
		stallMinutes: () => state.stallMinutes,
		now: () => state.clock,
		runtimeDir,
		debounceMs: 5,
		stallTickMs: 20,
		...(options.capacity ? { logCapacity: options.capacity } : {}),
		...(options.chargeFlushMs ? { chargeFlushMs: options.chargeFlushMs } : {}),
	});
	return Object.assign(state, {
		bus,
		broker,
		views,
		reads,
		frames,
		runtimeDir,
		listing: (repository: string) =>
			[...views.entries()]
				.filter(([key]) => key.startsWith(`${repository}\u0000`))
				.map(([, value]) => value),
	});
}

function put(harness: Harness, repo: string, value: WorkflowView): void {
	harness.views.set(`${repo}\u0000${value.workflowId}`, value);
}

async function waitUntil(
	condition: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !condition()) await sleep(5);
}

describe("derivation driver", () => {
	test("a burst of eight updates is one read", async () => {
		const harnessed = harness();
		put(harnessed, "/repo", view("wf-1"));
		for (let index = 0; index < 8; index += 1)
			harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		await sleep(30);
		expect(harnessed.reads).toHaveLength(1);
		harnessed.bus.stop();
	});

	test("the first observation is silent and a later one reports the edge", async () => {
		const harnessed = harness();
		put(harnessed, "/repo", view("wf-1", { step: "core.implementation" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		await sleep(20);
		expect(harnessed.bus.readEvents().events).toHaveLength(0);
		put(harnessed, "/repo", view("wf-1", { step: "core.developer-review" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.bus.readEvents().events.length > 0);
		const events = harnessed.bus.readEvents().events;
		expect(events.map((event) => event.id)).toEqual([
			"step.entered",
			"step.completed",
			"review.waiting",
		]);
		expect(events.at(-1)?.startedBy).toBe("orchestrator");
		expect(events.at(-1)?.humanNeeded).toBe(true);
		harnessed.bus.stop();
	});

	test("an unreadable view invents nothing", async () => {
		const harnessed = harness();
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		harnessed.views.clear();
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 2);
		await sleep(20);
		expect(harnessed.bus.readEvents().events).toHaveLength(0);
		harnessed.bus.stop();
	});

	test("monitor off derives nothing at all", async () => {
		const harnessed = harness({ mode: "off" });
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		harnessed.bus.noteRepositoryListed("/repo");
		await sleep(40);
		expect(harnessed.reads).toEqual([]);
		expect(harnessed.bus.readEvents().events).toHaveLength(0);
		expect(harnessed.frames).toEqual([]);
		harnessed.bus.stop();
	});

	test("a listing is a baseline, and a later listing reports a new workflow once", () => {
		const harnessed = harness();
		put(harnessed, "/repo", view("wf-1"));
		put(harnessed, "/repo", view("wf-2"));
		harnessed.bus.noteRepositoryListed("/repo");
		expect(harnessed.bus.readEvents().events).toHaveLength(0);
		put(harnessed, "/repo", view("wf-3"));
		harnessed.bus.noteRepositoryListed("/repo");
		const events = harnessed.bus.readEvents().events;
		expect(events).toHaveLength(1);
		expect(events[0]?.id).toBe("workflow.started");
		expect(events[0]?.workflowId).toBe("wf-3");
		harnessed.bus.noteRepositoryListed("/repo");
		expect(harnessed.bus.readEvents().events).toHaveLength(1);
		harnessed.bus.stop();
	});

	test("a stalled active workflow emits run.stalled once per unchanged workflow", async () => {
		const harnessed = harness();
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		// The threshold is configured relative to the clock the bus reads.
		(harnessed as unknown as { stallMinutes: number }).stallMinutes = 0;
		harnessed.clock += 5 * 60_000;
		await waitUntil(() =>
			harnessed.bus
				.readEvents()
				.events.some((event) => event.id === "run.stalled"),
		);
		const stalled = harnessed.bus
			.readEvents()
			.events.filter((event) => event.id === "run.stalled");
		expect(stalled).toHaveLength(1);
		expect(stalled[0]?.payload.minutes).toBeGreaterThan(0);
		await sleep(60);
		expect(
			harnessed.bus
				.readEvents()
				.events.filter((event) => event.id === "run.stalled"),
		).toHaveLength(1);
		harnessed.bus.stop();
	});

	test("the launch ceiling refusal is recorded with its counts", () => {
		const harnessed = harness();
		harnessed.bus.recordLimitHit({
			limit: "max_active",
			current: 5,
			maximum: 5,
		});
		const events = harnessed.bus.readEvents().events;
		expect(events).toHaveLength(1);
		expect(events[0]?.id).toBe("limit.hit");
		expect(events[0]?.payload).toMatchObject({
			limit: "max_active",
			current: 5,
			maximum: 5,
		});
		harnessed.bus.stop();
	});
});

describe("bounded log", () => {
	test("the sequence never restarts and a stale cursor is answered explicitly", () => {
		const harnessed = harness({ capacity: 3 });
		for (let index = 0; index < 5; index += 1)
			harnessed.bus.recordLimitHit({
				limit: "max_active",
				current: index,
				maximum: 5,
			});
		const all = harnessed.bus.readEvents();
		expect(all.events).toHaveLength(3);
		expect(all.oldestSequence).toBe(3);
		expect(all.events.map((event) => event.sequence)).toEqual([3, 4, 5]);
		const stale = harnessed.bus.readEvents({ after: 1 });
		expect(stale.cursorExpired).toBe(true);
		expect(stale.events).toEqual([]);
		expect(stale.oldestSequence).toBe(3);
		const page = harnessed.bus.readEvents({ after: 3, limit: 1 });
		expect(page.events.map((event) => event.sequence)).toEqual([4]);
		expect(page.nextCursor).toBe(4);
		harnessed.bus.stop();
	});
});

describe("subscriptions", () => {
	test("no explicit subscription is the implicit visible default", () => {
		const harnessed = harness();
		const subscriptions = harnessed.bus.listSubscriptions();
		expect(subscriptions).toHaveLength(1);
		expect(subscriptions[0]?.id).toBe("default");
		expect(subscriptions[0]?.implicit).toBe(true);
		expect(harnessed.bus.unsubscribe("default")).toBe(false);
		harnessed.bus.stop();
	});

	test("subscribe, list and remove round-trip, and removal is idempotent", () => {
		const harnessed = harness();
		const created = harnessed.bus.subscribe({
			label: "attention",
			reason: "watch failures",
			scope: undefined as never,
			filter: { scope: "mine", eventIds: ["attention.raised"] },
		} as never);
		expect(created.label).toBe("attention");
		expect(harnessed.bus.listSubscriptions()).toHaveLength(1);
		expect(harnessed.bus.unsubscribe(created.id)).toBe(true);
		expect(harnessed.bus.listSubscriptions()[0]?.id).toBe("default");
		expect(harnessed.bus.unsubscribe(created.id)).toBe(false);
		harnessed.bus.stop();
	});

	test("an unknown workflow id is refused and nothing is stored", () => {
		const harnessed = harness();
		expect(() =>
			harnessed.bus.subscribe({
				label: "unknown",
				filter: {
					scope: "mine",
					workflowIds: ["nope"],
					repositories: ["/repo"],
				},
			} as never),
		).toThrow(UnknownWorkflowError);
		expect(harnessed.bus.listSubscriptions()[0]?.id).toBe("default");
		harnessed.bus.stop();
	});

	test("the subscription cap is refused with the limit named", () => {
		const harnessed = harness();
		for (let index = 0; index < MAX_EVENT_SUBSCRIPTIONS; index += 1)
			harnessed.bus.subscribe({
				label: `sub-${index}`,
				filter: { scope: "mine" },
			} as never);
		expect(() =>
			harnessed.bus.subscribe({
				label: "one too many",
				filter: { scope: "mine" },
			} as never),
		).toThrow(SubscriptionLimitError);
		harnessed.bus.stop();
	});

	test("off mode refuses every subscription with the setting named", () => {
		const harnessed = harness({ mode: "off" });
		expect(() =>
			harnessed.bus.subscribe({
				label: "any",
				filter: { scope: "mine" },
			} as never),
		).toThrow(MonitorOffError);
		harnessed.bus.stop();
	});

	test("subscriptions survive a restart with the same session, and a new session prunes them", () => {
		const first = harness();
		const created = first.bus.subscribe({
			label: "persist",
			filter: { scope: "mine" },
		} as never);
		first.bus.stop();
		const second = createWorkflowEventBus({
			events: new EventBroker("second"),
			view: () => {
				throw new Error("unused");
			},
			listViews: () => [],
			monitorMode: () => "wake",
			runtimeDir: first.runtimeDir,
			now: () => first.clock,
			debounceMs: 5,
			stallTickMs: 100_000,
		});
		expect(
			second.listSubscriptions().map((subscription) => subscription.id),
		).toEqual([created.id]);
		second.stop();
		// A new orchestrator session owns nothing of the previous one.
		saveOrchestratorSessionName(first.runtimeDir, "orchestrator-2");
		const third = createWorkflowEventBus({
			events: new EventBroker("third"),
			view: () => {
				throw new Error("unused");
			},
			listViews: () => [],
			monitorMode: () => "wake",
			runtimeDir: first.runtimeDir,
			now: () => first.clock,
			debounceMs: 5,
			stallTickMs: 100_000,
		});
		expect(third.listSubscriptions()[0]?.id).toBe("default");
		third.stop();
	});

	test("expiry, an until-workflow and a spent event budget each prune", async () => {
		const harnessed = harness();
		const expiring = harnessed.bus.subscribe({
			label: "expiring",
			filter: { scope: "mine" },
			expiresAt: new Date(harnessed.clock + 60_000).toISOString(),
		} as never);
		const untilClosed = harnessed.bus.subscribe({
			label: "until",
			filter: { scope: "mine" },
			untilWorkflowClosed: "wf-1",
		} as never);
		const counted = harnessed.bus.subscribe({
			label: "counted",
			filter: { scope: "mine", eventIds: ["limit.hit"] },
			remainingEvents: 1,
		} as never);
		harnessed.clock += 120_000;
		expect(
			harnessed.bus.listSubscriptions().map((subscription) => subscription.id),
		).not.toContain(expiring.id);
		expect(
			harnessed.bus.listSubscriptions().map((subscription) => subscription.id),
		).toContain(untilClosed.id);

		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		await sleep(20);
		// The baseline is silent; the completion is what the until-condition waits
		// for.
		put(
			harnessed,
			"/repo",
			view("wf-1", { step: "core.completed", status: "completed" }),
		);
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await sleep(60);
		expect(
			harnessed.bus.listSubscriptions().map((subscription) => subscription.id),
		).not.toContain(untilClosed.id);

		harnessed.bus.recordLimitHit({
			limit: "max_active",
			current: 5,
			maximum: 5,
		});
		expect(
			harnessed.bus.listSubscriptions().map((subscription) => subscription.id),
		).not.toContain(counted.id);
		harnessed.bus.stop();
	});
});

describe("delivery frames", () => {
	test("a human-needed event is published whatever the subscriptions, and a silent-only match is not", async () => {
		const harnessed = harness();
		harnessed.bus.subscribe({
			label: "silent",
			mode: "silent",
			filter: {
				scope: "mine",
				eventIds: ["step.entered", "review.waiting"],
			},
		} as never);
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		harnessed.frames.length = 0;
		// A step edge matches only the silent subscription: no frame.
		put(harnessed, "/repo", view("wf-1", { step: "core.planning" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 2);
		await sleep(30);
		expect(harnessed.frames).toEqual([]);
		// A review entering is human-needed: the frame is published, naming the
		// silent subscription so the shell knows not to deliver it as a note.
		put(harnessed, "/repo", view("wf-1", { step: "core.developer-review" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.frames.length > 0);
		const review = harnessed.frames.find(
			(frame) => frame.event.id === "review.waiting",
		);
		expect(review?.event.humanNeeded).toBe(true);
		expect(review?.subscriptions).toEqual([
			{ id: expect.any(String), label: "silent", mode: "silent" },
		]);
		harnessed.bus.stop();
	});

	test("notify mode publishes no subscription frame", async () => {
		const harnessed = harness({ mode: "notify" });
		harnessed.bus.subscribe({
			label: "waking",
			mode: "wake",
			filter: { scope: "mine", categories: ["step"] },
		} as never);
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		put(harnessed, "/repo", view("wf-1", { step: "core.planning" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 2);
		await sleep(30);
		expect(harnessed.frames).toEqual([]);
		expect(harnessed.bus.listSubscriptions()[0]?.label).toBe("waking");
		harnessed.bus.stop();
	});
});

describe("the implicit default subscription", () => {
	test("delivers when nothing is stored, and any explicit subscription replaces it", async () => {
		const harnessed = harness();
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		harnessed.frames.length = 0;
		// `attention.raised` is one of the default subscription's ids: with no
		// stored record at all the frame must still name the default.
		put(harnessed, "/repo", view("wf-1", { attention: ["run failed"] }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.frames.length > 0);
		const raised = harnessed.frames.find(
			(frame) => frame.event.id === "attention.raised",
		);
		expect(raised?.subscriptions.map((match) => match.label)).toEqual([
			"default",
		]);
		expect(raised?.subscriptions[0]?.mode).toBe("wake");

		// One explicit subscription replaces the implicit default entirely.
		harnessed.bus.subscribe({
			label: "only-steps",
			filter: { scope: "mine", categories: ["step"] },
		} as never);
		harnessed.frames.length = 0;
		put(
			harnessed,
			"/repo",
			view("wf-1", { step: "core.planning", attention: ["run failed"] }),
		);
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.frames.length > 0);
		for (const frame of harnessed.frames)
			expect(frame.subscriptions.map((match) => match.label)).not.toContain(
				"default",
			);
		harnessed.bus.stop();
	});
});

describe("subscription identity and cadence", () => {
	test("two subscriptions with one label inside one instant get distinct ids", () => {
		const harnessed = harness();
		const first = harnessed.bus.subscribe({
			label: "attention",
			filter: { scope: "mine" },
		} as never);
		const second = harnessed.bus.subscribe({
			label: "attention",
			filter: { scope: "mine" },
		} as never);
		expect(first.id).not.toBe(second.id);
		expect(harnessed.bus.unsubscribe(first.id)).toBe(true);
		expect(
			harnessed.bus.listSubscriptions().map((subscription) => subscription.id),
		).toEqual([second.id]);
		harnessed.bus.stop();
	});

	test("the frame carries the subscription's own cadence overrides", async () => {
		const harnessed = harness();
		harnessed.bus.subscribe({
			label: "digesting",
			mode: "digest",
			digestMinutes: 3,
			coalesceMs: 2_000,
			minIntervalMs: 9_000,
			filter: { scope: "mine", eventIds: ["review.waiting"] },
		} as never);
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		put(harnessed, "/repo", view("wf-1", { step: "core.developer-review" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.frames.length > 0);
		const review = harnessed.frames.find(
			(frame) => frame.event.id === "review.waiting",
		);
		expect(review?.subscriptions).toEqual([
			{
				id: expect.any(String),
				label: "digesting",
				mode: "digest",
				digestMinutes: 3,
				coalesceMs: 2_000,
				minIntervalMs: 9_000,
			},
		]);
		harnessed.bus.stop();
	});

	test("a delivered frame stamps the subscription's last delivery and spends its budget", async () => {
		const harnessed = harness();
		const created = harnessed.bus.subscribe({
			label: "budgeted",
			remainingEvents: 2,
			filter: { scope: "mine", eventIds: ["review.waiting"] },
		} as never);
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		harnessed.clock += 1_000;
		put(harnessed, "/repo", view("wf-1", { step: "core.developer-review" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(
			() => harnessed.bus.listSubscriptions()[0]?.lastDeliveredAt !== undefined,
		);
		const after = harnessed.bus.listSubscriptions()[0];
		expect(after?.id).toBe(created.id);
		expect(after?.remainingEvents).toBe(1);
		expect(after?.lastDeliveredAt).toBe("2026-01-01T00:00:01.000Z");
		harnessed.bus.stop();
	});
});

describe("filter bounds", () => {
	test("a filter beyond a bound, an unknown id and a bad cadence are refused by name", () => {
		const harnessed = harness();
		const subscribe = (filter: unknown, extra: Record<string, unknown> = {}) =>
			harnessed.bus.subscribe({ label: "bounded", filter, ...extra } as never);
		expect(() =>
			subscribe({
				scope: "mine",
				workflowIds: Array.from({ length: 21 }, (_, index) => `wf-${index}`),
			}),
		).toThrow("filter.workflowIds is limited to 20 ids");
		expect(() =>
			subscribe({
				scope: "mine",
				repositories: Array.from({ length: 9 }, (_, index) => `/repo-${index}`),
			}),
		).toThrow("filter.repositories is limited to 8 paths");
		expect(() =>
			subscribe({
				scope: "mine",
				eventIds: Array.from({ length: 33 }, () => "step.entered"),
			}),
		).toThrow("filter.eventIds is limited to 32 ids");
		expect(() =>
			subscribe({
				scope: "mine",
				categories: Array.from({ length: 14 }, () => "step"),
			}),
		).toThrow("filter.categories is limited to 13 categories");
		expect(() => subscribe({ scope: "mine", eventIds: ["nope"] })).toThrow(
			"unknown event id: nope",
		);
		expect(() => subscribe({ scope: "mine", categories: ["nope"] })).toThrow(
			"unknown event category: nope",
		);
		expect(() => subscribe({ scope: "mine", minSeverity: "loud" })).toThrow(
			"filter.minSeverity must be info, warning or critical",
		);
		expect(() => subscribe({ scope: "loud" })).toThrow(
			"filter.scope must be `mine` or `all`",
		);
		expect(() =>
			subscribe({}, { expiresAt: "2020-01-01T00:00:00.000Z" }),
		).toThrow("expiresAt must be an ISO instant in the future");
		expect(() =>
			subscribe({}, { expiresAt: "2027-01-01T00:00:00.000Z" }),
		).toThrow("expiresAt must be within 30 days");
		expect(() => subscribe({}, { coalesceMs: 0 })).toThrow(
			"coalesceMs must be a positive number",
		);
		expect(() => subscribe({}, { label: "x".repeat(41) })).toThrow(
			"a label is limited to 40 characters",
		);
		harnessed.bus.stop();
	});
});

describe("durable, owner-scoped state", () => {
	test("a store written by a later version is refused, not read as if it were this one", () => {
		const harnessed = harness();
		fs.writeFileSync(
			path.join(harnessed.runtimeDir, "event-subscriptions.json"),
			JSON.stringify({
				version: 2,
				subscriptions: [
					{
						id: "sub-future",
						label: "future",
						reason: "",
						session: "orchestrator",
						createdAt: "2026-01-01T00:00:00.000Z",
						expiresAt: "2026-02-01T00:00:00.000Z",
						mode: "wake",
						filter: { scope: "mine" },
					},
				],
			}),
		);
		expect(harnessed.bus.listSubscriptions().map((s) => s.id)).toEqual([
			"default",
		]);
		harnessed.bus.stop();
	});

	test("an until-workflow condition resolves from the durable closed list after a restart", () => {
		const harnessed = harness();
		const store = path.join(harnessed.runtimeDir, "event-subscriptions.json");
		const record = {
			id: "sub-until-wf-1",
			label: "until",
			reason: "",
			session: "orchestrator",
			createdAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2026-02-01T00:00:00.000Z",
			mode: "wake",
			filter: { scope: "mine" },
			untilWorkflowClosed: "wf-1",
		};
		harnessed.bus.stop();
		// A store whose `closed` list already names the workflow: a process that
		// never saw the close event still drops the record.
		fs.writeFileSync(
			store,
			JSON.stringify({ version: 1, subscriptions: [record], closed: ["wf-1"] }),
		);
		const restarted = createWorkflowEventBus({
			events: new EventBroker("restart"),
			view: () => {
				throw new Error("unused");
			},
			listViews: () => [],
			monitorMode: () => "wake",
			runtimeDir: harnessed.runtimeDir,
			now: () => harnessed.clock,
			debounceMs: 5,
			stallTickMs: 100_000,
		});
		expect(restarted.listSubscriptions().map((s) => s.id)).toEqual(["default"]);
		restarted.stop();
		// Without the closure the record survives, so the list is what decides.
		fs.writeFileSync(
			store,
			JSON.stringify({ version: 1, subscriptions: [record], closed: [] }),
		);
		const open = createWorkflowEventBus({
			events: new EventBroker("open"),
			view: () => {
				throw new Error("unused");
			},
			listViews: () => [],
			monitorMode: () => "wake",
			runtimeDir: harnessed.runtimeDir,
			now: () => harnessed.clock,
			debounceMs: 5,
			stallTickMs: 100_000,
		});
		expect(open.listSubscriptions().map((s) => s.id)).toEqual([
			"sub-until-wf-1",
		]);
		open.stop();
	});

	test("a write re-reads what is on disk, so another writer's record is not lost", () => {
		const harnessed = harness();
		const store = path.join(harnessed.runtimeDir, "event-subscriptions.json");
		const first = harnessed.bus.subscribe({
			label: "first",
			filter: { scope: "mine" },
		} as never);
		// Another shell (or another process) appends to the same store.
		const written = JSON.parse(fs.readFileSync(store, "utf8")) as {
			subscriptions: unknown[];
		};
		written.subscriptions.push({
			id: "sub-other",
			label: "other",
			reason: "",
			session: "orchestrator",
			createdAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2026-02-01T00:00:00.000Z",
			mode: "wake",
			filter: { scope: "mine" },
		});
		fs.writeFileSync(store, JSON.stringify(written));
		const third = harnessed.bus.subscribe({
			label: "third",
			filter: { scope: "mine" },
		} as never);
		const ids = harnessed.bus
			.listSubscriptions()
			.map((subscription) => subscription.id);
		expect(ids).toContain(first.id);
		expect(ids).toContain("sub-other");
		expect(ids).toContain(third.id);
		harnessed.bus.stop();
	});
});

describe("failure isolation", () => {
	test("a publish that throws drops that draft only, never the rest of the observation", () => {
		const broker = {
			open: () => ({
				replay: [],
				snapshotRequired: false,
				unsubscribe: () => {},
			}),
			publish: () => {
				throw new Error("publish failed");
			},
		} as never;
		const bus = createWorkflowEventBus({
			events: broker,
			view: () => view("wf-1"),
			listViews: () => [view("wf-1")],
			monitorMode: () => "wake",
			runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), "wf-events-throw-")),
			debounceMs: 5,
			stallTickMs: 100_000,
		});
		bus.recordLimitHit({ limit: "max_active", current: 5, maximum: 5 });
		bus.recordLimitHit({ limit: "max_active", current: 6, maximum: 5 });
		expect(bus.readEvents().events).toHaveLength(2);
		bus.stop();
	});

	test("a re-read of an unchanged workflow does not reset the stall clock", async () => {
		const harnessed = harness();
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		(harnessed as unknown as { stallMinutes: number }).stallMinutes = 0;
		harnessed.clock += 5 * 60_000;
		// The same workflow is read again with no change at all: that is not
		// progress, so `run.stalled` must still be reported.
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 2);
		await waitUntil(() =>
			harnessed.bus
				.readEvents()
				.events.some((event) => event.id === "run.stalled"),
		);
		expect(
			harnessed.bus
				.readEvents()
				.events.filter((event) => event.id === "run.stalled"),
		).toHaveLength(1);
		harnessed.bus.stop();
	});

	test("a stalled developer-started workflow is not reported as the orchestrator's", async () => {
		const harnessed = harness();
		put(harnessed, "/repo", view("dev-1", { startedBy: "developer" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "dev-1");
		await waitUntil(() => harnessed.reads.length === 1);
		(harnessed as unknown as { stallMinutes: number }).stallMinutes = 0;
		harnessed.clock += 5 * 60_000;
		await waitUntil(() =>
			harnessed.bus
				.readEvents()
				.events.some((event) => event.id === "run.stalled"),
		);
		const stalled = harnessed.bus
			.readEvents()
			.events.find((event) => event.id === "run.stalled");
		expect(stalled?.startedBy).toBe("developer");
		expect(matchesSubscriptionFilter({ scope: "mine" }, stalled as never)).toBe(
			false,
		);
		harnessed.bus.stop();
	});
});

describe("reads", () => {
	test("a filter with no scope still narrows, and an absent filter reads everything", () => {
		const harnessed = harness();
		harnessed.bus.recordLimitHit({
			limit: "max_active",
			current: 5,
			maximum: 5,
		});
		harnessed.bus.recordLimitHit({
			limit: "max_starts_per_day",
			current: 20,
			maximum: 20,
		});
		expect(harnessed.bus.readEvents().events).toHaveLength(2);
		const narrowed = harnessed.bus.readEvents({
			filter: { eventIds: ["limit.hit"] },
		});
		expect(narrowed.events).toHaveLength(2);
		const none = harnessed.bus.readEvents({
			filter: { eventIds: ["review.waiting"] },
		});
		expect(none.events).toEqual([]);
		const critical = harnessed.bus.readEvents({
			filter: { eventIds: ["limit.hit"], minSeverity: "critical" },
		});
		expect(critical.events).toEqual([]);
		harnessed.bus.stop();
	});
});

describe("the durable store survives what it cannot read", () => {
	function storePath(harnessed: Harness): string {
		return path.join(harnessed.runtimeDir, "event-subscriptions.json");
	}

	test("a version this build does not know is neither read nor overwritten", () => {
		const harnessed = harness();
		const store = storePath(harnessed);
		fs.writeFileSync(
			store,
			JSON.stringify({
				version: 2,
				subscriptions: [
					{
						id: "sub-future",
						label: "future",
						reason: "",
						session: "orchestrator",
						createdAt: "2026-01-01T00:00:00.000Z",
						expiresAt: "2026-02-01T00:00:00.000Z",
						mode: "wake",
						filter: { scope: "mine" },
					},
				],
			}),
		);
		const before = fs.readFileSync(store, "utf8");
		expect(harnessed.bus.listSubscriptions().map((s) => s.id)).toEqual([
			"default",
		]);
		// An explicit mutation is refused...
		expect(() =>
			harnessed.bus.subscribe({
				label: "mine",
				filter: { scope: "mine" },
			} as never),
		).toThrow(StoreUnreadableError);
		// ...and a background delivery write does not touch the file either.
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		harnessed.bus.recordLimitHit({
			limit: "max_active",
			current: 5,
			maximum: 5,
		});
		expect(fs.readFileSync(store, "utf8")).toBe(before);
		harnessed.bus.stop();
	});

	test("another session's records are kept, not deleted, by this session's writes", () => {
		const harnessed = harness();
		const store = storePath(harnessed);
		fs.writeFileSync(
			store,
			JSON.stringify({
				version: 1,
				subscriptions: [
					{
						id: "sub-other-session",
						label: "other",
						reason: "",
						session: "orchestrator-other",
						createdAt: "2026-01-01T00:00:00.000Z",
						expiresAt: "2026-02-01T00:00:00.000Z",
						mode: "wake",
						filter: { scope: "mine" },
					},
				],
				closed: ["wf-9"],
			}),
		);
		const created = harnessed.bus.subscribe({
			label: "mine",
			filter: { scope: "mine" },
		} as never);
		// Listing is scoped to the active session...
		expect(
			harnessed.bus.listSubscriptions().map((subscription) => subscription.id),
		).toEqual([created.id]);
		// ...but the file keeps the other session's record and its closed id.
		const written = JSON.parse(fs.readFileSync(store, "utf8")) as {
			subscriptions: Array<{ id: string }>;
			closed: string[];
		};
		expect(written.subscriptions.map((record) => record.id)).toContain(
			"sub-other-session",
		);
		expect(written.closed).toContain("wf-9");
		harnessed.bus.stop();
	});

	test("an unreadable session file prunes nothing", () => {
		const harnessed = harness();
		const store = storePath(harnessed);
		fs.writeFileSync(
			store,
			JSON.stringify({
				version: 1,
				subscriptions: [
					{
						id: "sub-live",
						label: "live",
						reason: "",
						session: "orchestrator-m1abc",
						createdAt: "2026-01-01T00:00:00.000Z",
						expiresAt: "2026-02-01T00:00:00.000Z",
						mode: "wake",
						filter: { scope: "mine" },
					},
				],
			}),
		);
		// A partial write of session.json: no name can be read, so the bus must not
		// decide that a session's records are foreign - and it must not stamp a
		// guessed name on a new record either.
		const sessionFile = path.join(harnessed.runtimeDir, "session.json");
		fs.writeFileSync(sessionFile, '{ "name":');
		// No stored record is live while no session can be named: it is kept on
		// disk (asserted below) but reported as nobody's.
		expect(harnessed.bus.listSubscriptions().map((s) => s.id)).toEqual([
			"default",
		]);
		expect(() =>
			harnessed.bus.subscribe({
				label: "mine",
				filter: { scope: "mine" },
			} as never),
		).toThrow(UnknownSessionError);
		const written = JSON.parse(fs.readFileSync(store, "utf8")) as {
			subscriptions: Array<{ id: string }>;
		};
		expect(written.subscriptions.map((record) => record.id)).toContain(
			"sub-live",
		);
		// Once the session is readable again the records are live and a mutation is
		// accepted under the real name.
		fs.writeFileSync(
			sessionFile,
			JSON.stringify({ name: "orchestrator-m1abc" }),
		);
		const created = harnessed.bus.subscribe({
			label: "mine",
			filter: { scope: "mine" },
		} as never);
		expect(created.session).toBe("orchestrator-m1abc");
		harnessed.bus.stop();
	});

	test("the closed list a second writer appended is not clobbered", () => {
		const harnessed = harness();
		const store = storePath(harnessed);
		harnessed.bus.subscribe({
			label: "mine",
			filter: { scope: "mine" },
		} as never);
		const written = JSON.parse(fs.readFileSync(store, "utf8")) as {
			closed?: string[];
		};
		written.closed = ["wf-other"];
		fs.writeFileSync(store, JSON.stringify({ version: 1, ...written }));
		harnessed.bus.subscribe({
			label: "second",
			filter: { scope: "mine" },
		} as never);
		const after = JSON.parse(fs.readFileSync(store, "utf8")) as {
			closed: string[];
		};
		expect(after.closed).toContain("wf-other");
		harnessed.bus.stop();
	});

	test("the bus writes the closed list it observes, and a restart reads it", async () => {
		const harnessed = harness();
		const store = storePath(harnessed);
		const created = harnessed.bus.subscribe({
			label: "until",
			untilWorkflowClosed: "wf-1",
			filter: { scope: "mine" },
		} as never);
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		put(harnessed, "/repo", view("wf-1", { status: "completed" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(
			() =>
				(
					JSON.parse(fs.readFileSync(store, "utf8")) as { closed?: string[] }
				).closed?.includes("wf-1") === true,
		);
		const written = JSON.parse(fs.readFileSync(store, "utf8")) as {
			closed: string[];
		};
		expect(written.closed).toContain("wf-1");
		// A process that never saw the close still drops the record.
		const restarted = createWorkflowEventBus({
			events: new EventBroker("restart-closed"),
			view: () => {
				throw new Error("unused");
			},
			listViews: () => [],
			monitorMode: () => "wake",
			runtimeDir: harnessed.runtimeDir,
			now: () => harnessed.clock,
			debounceMs: 5,
			stallTickMs: 100_000,
		});
		expect(restarted.listSubscriptions().map((s) => s.id)).not.toContain(
			created.id,
		);
		restarted.stop();
		harnessed.bus.stop();
	});
});

describe("budget semantics and enrichment wiring", () => {
	test("a silent subscription ends by count: the budget counts matched events", async () => {
		const harnessed = harness();
		const created = harnessed.bus.subscribe({
			label: "quiet",
			mode: "silent",
			remainingEvents: 1,
			filter: { scope: "mine", eventIds: ["review.waiting"] },
		} as never);
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		put(harnessed, "/repo", view("wf-1", { step: "core.developer-review" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 2);
		await waitUntil(() =>
			harnessed.bus.listSubscriptions().every((s) => s.id !== created.id),
		);
		expect(harnessed.bus.listSubscriptions().map((s) => s.id)).toEqual([
			"default",
		]);
		harnessed.bus.stop();
	});

	test("the injected enrichment advances the carried baseline, so one compaction is one event", async () => {
		const runtimeDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "wf-events-enrich-"),
		);
		let compactions = [compactionEntry("implementer", "first")];
		const bus = createWorkflowEventBus({
			events: new EventBroker("enrich"),
			view: (_repository, workflowId) => view(workflowId),
			listViews: () => [view("wf-1")],
			monitorMode: () => "wake",
			runtimeDir,
			debounceMs: 5,
			stallTickMs: 100_000,
			enrich: () => ({ compaction: compactions }),
		});
		bus.noteWorkflowUpdated("/repo", "wf-1");
		await sleep(20);
		bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(
			() =>
				bus.readEvents().events.filter((event) => event.id === "compaction")
					.length === 1,
		);
		// A second entry is one more event, never a repeat of the first.
		compactions = [
			compactionEntry("implementer", "first"),
			compactionEntry("verifier", "second"),
		];
		bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(
			() =>
				bus.readEvents().events.filter((event) => event.id === "compaction")
					.length === 2,
		);
		await sleep(20);
		expect(
			bus.readEvents().events.filter((event) => event.id === "compaction"),
		).toHaveLength(2);
		bus.stop();
	});
});

function compactionEntry(role: string, reason: string) {
	return { role, reason };
}

describe("record budget, closed bound and flush isolation", () => {
	test("a silent subscription ends by count on a non-human event too", async () => {
		const harnessed = harness();
		const created = harnessed.bus.subscribe({
			label: "quiet-steps",
			mode: "silent",
			remainingEvents: 1,
			filter: { scope: "mine", eventIds: ["step.entered"] },
		} as never);
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		// `step.entered` is not human-needed and matches no wake/digest
		// subscription, so no frame is published - the record budget still counts.
		put(harnessed, "/repo", view("wf-1", { step: "core.planning" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() =>
			harnessed.bus.listSubscriptions().every((s) => s.id !== created.id),
		);
		expect(harnessed.bus.listSubscriptions().map((s) => s.id)).toEqual([
			"default",
		]);
		harnessed.bus.stop();
	});

	test("the closed list is bounded to the newest ids", () => {
		const harnessed = harness();
		const store = path.join(harnessed.runtimeDir, "event-subscriptions.json");
		fs.writeFileSync(
			store,
			JSON.stringify({
				version: 1,
				subscriptions: [],
				closed: Array.from({ length: 250 }, (_, index) => `wf-${index}`),
			}),
		);
		harnessed.bus.subscribe({
			label: "mine",
			filter: { scope: "mine" },
		} as never);
		const written = JSON.parse(fs.readFileSync(store, "utf8")) as {
			closed: string[];
		};
		expect(written.closed).toHaveLength(200);
		expect(written.closed).toContain("wf-249");
		expect(written.closed).not.toContain("wf-0");
		harnessed.bus.stop();
	});

	test("a store write that throws keeps the charge and never escapes the timer", async () => {
		const harnessed = harness({ chargeFlushMs: 10 });
		const created = harnessed.bus.subscribe({
			label: "charged",
			remainingEvents: 5,
			filter: { scope: "mine", eventIds: ["review.waiting"] },
		} as never);
		// A store that cannot be written (the runtime directory loses its write
		// permission): the flush must report the failure, keep the buffered charge
		// and never throw out of the timer.
		fs.chmodSync(harnessed.runtimeDir, 0o500);
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		put(harnessed, "/repo", view("wf-1", { step: "core.developer-review" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 2);
		// Several flush windows pass while the write keeps failing.
		await sleep(60);
		expect(
			harnessed.bus.readEvents().events.some((e) => e.id === "review.waiting"),
		).toBe(true);
		await sleep(100);
		// The path becomes writable again: the buffered charge lands, once.
		fs.chmodSync(harnessed.runtimeDir, 0o700);
		await waitUntil(
			() => harnessed.bus.listSubscriptions()[0]?.remainingEvents === 4,
			3_000,
		);
		const after = harnessed.bus.listSubscriptions()[0];
		expect(after?.id).toBe(created.id);
		expect(after?.remainingEvents).toBe(4);
		expect(after?.lastDeliveredAt).toBeDefined();
		harnessed.bus.stop();
	});

	test("a background write over an unreadable store leaves it byte-identical", async () => {
		const harnessed = harness();
		const store = path.join(harnessed.runtimeDir, "event-subscriptions.json");
		const before = JSON.stringify({
			version: 99,
			subscriptions: [],
			closed: [],
		});
		fs.writeFileSync(store, before);
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		// The close path reaches the background store write.
		put(harnessed, "/repo", view("wf-1", { status: "completed" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 2);
		await sleep(30);
		expect(fs.readFileSync(store, "utf8")).toBe(before);
		harnessed.bus.stop();
	});
});

describe("the durable half of a delivery charge", () => {
	test("a charge reaches the store, and a second bus reads it back", async () => {
		const harnessed = harness({ chargeFlushMs: 10 });
		const store = path.join(harnessed.runtimeDir, "event-subscriptions.json");
		const created = harnessed.bus.subscribe({
			label: "durable",
			remainingEvents: 3,
			filter: { scope: "mine", eventIds: ["review.waiting"] },
		} as never);
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		harnessed.clock += 1_000;
		put(harnessed, "/repo", view("wf-1", { step: "core.developer-review" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		// The file, not the in-memory listing, is the assertion: a buffered charge
		// that never lands would keep `list_subscriptions` right and lose the
		// budget across a restart.
		await waitUntil(
			() =>
				(
					JSON.parse(fs.readFileSync(store, "utf8")) as {
						subscriptions?: Array<{ remainingEvents?: number }>;
					}
				).subscriptions?.[0]?.remainingEvents === 2,
		);
		const written = JSON.parse(fs.readFileSync(store, "utf8")) as {
			subscriptions: Array<{
				id: string;
				remainingEvents?: number;
				lastDeliveredAt?: string;
			}>;
		};
		expect(written.subscriptions[0]?.remainingEvents).toBe(2);
		expect(written.subscriptions[0]?.lastDeliveredAt).toBe(
			"2026-01-01T00:00:01.000Z",
		);
		const restarted = createWorkflowEventBus({
			events: new EventBroker("charge-restart"),
			view: () => {
				throw new Error("unused");
			},
			listViews: () => [],
			monitorMode: () => "wake",
			runtimeDir: harnessed.runtimeDir,
			now: () => harnessed.clock,
			debounceMs: 5,
			stallTickMs: 100_000,
		});
		expect(restarted.listSubscriptions()[0]?.id).toBe(created.id);
		expect(restarted.listSubscriptions()[0]?.remainingEvents).toBe(2);
		restarted.stop();
		harnessed.bus.stop();
	});

	test("notify mode charges the budget and stamps no delivery", async () => {
		const harnessed = harness({ mode: "notify", chargeFlushMs: 10 });
		const store = path.join(harnessed.runtimeDir, "event-subscriptions.json");
		const created = harnessed.bus.subscribe({
			label: "muted",
			remainingEvents: 5,
			filter: { scope: "mine", eventIds: ["step.entered"] },
		} as never);
		put(harnessed, "/repo", view("wf-1"));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(() => harnessed.reads.length === 1);
		put(harnessed, "/repo", view("wf-1", { step: "core.planning" }));
		harnessed.bus.noteWorkflowUpdated("/repo", "wf-1");
		await waitUntil(
			() =>
				(
					JSON.parse(fs.readFileSync(store, "utf8")) as {
						subscriptions?: Array<{ remainingEvents?: number }>;
					}
				).subscriptions?.[0]?.remainingEvents === 4,
		);
		const written = JSON.parse(fs.readFileSync(store, "utf8")) as {
			subscriptions: Array<{
				id: string;
				remainingEvents?: number;
				lastDeliveredAt?: string;
			}>;
		};
		expect(written.subscriptions[0]?.id).toBe(created.id);
		expect(written.subscriptions[0]?.remainingEvents).toBe(4);
		// The master switch suppressed the note, so no delivery is claimed.
		expect(written.subscriptions[0]?.lastDeliveredAt).toBeUndefined();
		expect(harnessed.frames).toEqual([]);
		harnessed.bus.stop();
	});
});
