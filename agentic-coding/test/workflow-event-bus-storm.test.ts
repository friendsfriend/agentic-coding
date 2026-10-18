// Workflow event bus storm (fix-event-bus-storm). The regression: during one
// long, non-agent step of an env-setup workflow (`setup.validate`, where the
// engine commits an effect and the refresh hub therefore publishes a
// repository-level `workflow.updated` with no workflow id), the bus recorded and
// delivered the same transition again and again - `step.completed` for the
// finished author run followed by `run.completed` for the same run - until the
// workflow left the step.
//
// The shape these tests drive is the production one, with the bus's two
// amplifiers left in place so the reproduction cannot be dismissed as a test
// artefact:
//
//   * a live subscription matches the transition, so recording it publishes a
//     delivery frame (the orchestrator session's own subscription does);
//   * the broker's per-subscriber queue is at its capacity, which in a server
//     that has published `EVENT_REPLAY_CAPACITY` events is permanent, so the
//     bus's own subscription reports an overflow on every later publish.
//
// Every test carries a loop guard: the harness stops answering listings and
// records that the bound was passed, so a storm fails the test instead of
// hanging it.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import type { WorkflowEventDeliveryFrame } from "../src/contracts/workflow-events.ts";
import { saveOrchestratorSessionName } from "../src/orchestrator-state.ts";
import { EventBroker } from "../src/server/events.ts";
import {
	createWorkflowEventBus,
	type WorkflowEventBus,
} from "../src/server/workflow-event-bus.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The events one real transition may legitimately produce. Anything beyond
 * this is a storm, and the guard below turns it into a failure. */
const MAX_EXPECTED_FRAMES = 12;

const REPO = "/repo";

interface EnvSetupRun {
	readonly id: string;
	readonly attempt: number;
	readonly status: string;
}

/** One env-setup-like workflow: the author step is an agent step, `validate`,
 * `smoke` and `approval` follow it. */
function envSetupView(input: {
	step: string;
	attempt: number;
	runs: readonly EnvSetupRun[];
	status?: WorkflowView["status"];
	workflowId?: string;
	attention?: readonly string[];
	questions?: readonly string[];
}): WorkflowView {
	return {
		workflowId: input.workflowId ?? "env-setup-grid-allocation-backend-3",
		changeId: "env-setup-grid-allocation-backend",
		status: input.status ?? "active",
		startedBy: "orchestrator",
		task: "draft the environment",
		worktree: "/worktrees/env-setup-3",
		currentStep: {
			id: input.step,
			label: input.step,
			attempt: input.attempt,
			enteredAt: "",
		},
		runs: input.runs.map((run) => ({
			id: run.id,
			role: "env-setup",
			stepId: "setup.author",
			attempt: run.attempt,
			status: run.status,
		})),
		pendingQuestions: (input.questions ?? []).map((id) => ({
			id,
			role: "developer",
		})),
		effects: [],
		health: { valid: true, attention: [...(input.attention ?? [])] },
		availableActions: [],
	} as unknown as WorkflowView;
}

/** The bus under a fake store, plus the counters the guards read. */
interface StormHarness {
	readonly bus: WorkflowEventBus;
	readonly broker: EventBroker;
	readonly frames: WorkflowEventDeliveryFrame[];
	readonly listings: string[];
	readonly errors: unknown[];
	readonly put: (view: WorkflowView) => void;
	/** Publish one repository-level `workflow.updated`, exactly as the refresh
	 * hub's progress listener does on every committed effect. */
	readonly progress: () => void;
	/** How many delivery frames were published beyond the guard. */
	stormed: boolean;
	/** How deep the fake store's listing calls nested (`1` is "never nested"). */
	readonly listingDepth: { current: number; max: number };
	/** The fake clock the bus reads; advancing it opens the next rate-limit
	 * window. */
	clock: number;
	stop: () => void;
}

function stormHarness(
	options: {
		brokerCapacity?: number;
		subscribed?: boolean;
		reconcileMs?: number;
		maxEventsPerWindow?: number;
		eventWindowMs?: number;
		/** Ask for another re-list of the repository *while* one is running, the
		 * way a re-entered bus did it. */
		reentrantListing?: boolean;
	} = {},
): StormHarness {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-events-storm-"));
	saveOrchestratorSessionName(runtimeDir, "orchestrator");
	// A small capacity stands in for the production broker: what matters is that
	// the bus's own subscription is at its queue capacity, which
	// `EVENT_REPLAY_CAPACITY` (512) publishes makes permanent in a real server.
	const broker = new EventBroker("storm", options.brokerCapacity ?? 4);
	const views = new Map<string, WorkflowView>();
	const listings: string[] = [];
	const frames: WorkflowEventDeliveryFrame[] = [];
	const errors: unknown[] = [];
	const listingDepth = { current: 0, max: 0 };
	let busRef: WorkflowEventBus | undefined;
	let reentered = false;
	const state = {
		stormed: false,
		/** Set by the loop guard: the harness stops answering listings so the
		 * re-entrant observation cannot continue, and the test fails on
		 * `stormed`. */
		listingUnavailable: false,
		clock: Date.parse("2026-10-18T09:25:00.000Z"),
	};
	broker.open({}, (event) => {
		if (event.domain !== "workflow-event" || !event.payload) return;
		frames.push(event.payload as WorkflowEventDeliveryFrame);
		if (frames.length > MAX_EXPECTED_FRAMES) {
			state.stormed = true;
			state.listingUnavailable = true;
		}
	});
	const bus = createWorkflowEventBus({
		events: broker,
		view: (_repository, workflowId) => {
			const found = views.get(workflowId);
			if (!found) throw new Error("no such workflow");
			return found;
		},
		listViews: (repository) => {
			if (state.listingUnavailable) throw new Error("loop guard");
			listings.push(repository);
			listingDepth.current += 1;
			listingDepth.max = Math.max(listingDepth.max, listingDepth.current);
			if (options.reentrantListing && !reentered) {
				reentered = true;
				busRef?.noteRepositoryListed(repository);
			}
			const listed = [...views.values()];
			listingDepth.current -= 1;
			return listed;
		},
		monitorMode: () => "wake",
		now: () => state.clock,
		runtimeDir,
		debounceMs: 5,
		stallTickMs: 1_000_000,
		reconcileMs: () => options.reconcileMs ?? 0,
		onError: (error) => errors.push(error),
		...(options.maxEventsPerWindow !== undefined
			? { maxEventsPerWindow: options.maxEventsPerWindow }
			: {}),
		...(options.eventWindowMs !== undefined
			? { eventWindowMs: options.eventWindowMs }
			: {}),
	});
	// The orchestrator session's own subscription: a workflow it started, every
	// event of it. Without a matching subscription nothing would be published and
	// the amplification below would have nothing to carry it.
	if (options.subscribed ?? true)
		bus.subscribe({
			label: "orchestrator",
			mode: "wake",
			filter: { scope: "all" },
		});
	busRef = bus;
	return Object.assign(state, {
		bus,
		broker,
		frames,
		listings,
		errors,
		listingDepth,
		put: (view: WorkflowView) => {
			views.set(view.workflowId, view);
		},
		progress: () => {
			broker.publish({
				domain: "workflow",
				kind: "workflow.updated",
				resource: REPO,
			});
		},
		stop: () => bus.stop(),
	});
}

async function waitUntil(
	condition: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !condition()) await sleep(5);
}

/** The events one transition produced, in the order they were recorded. */
function eventIds(harness: StormHarness): string[] {
	return harness.bus.readEvents({ limit: 200 }).events.map((event) => event.id);
}

describe("event storm", () => {
	/** The production shape: the author run (attempt 2, after an expired attempt
	 * 1) finished and the workflow entered the long, non-agent `setup.validate`
	 * effect, which keeps committing progress. */
	test("one transition is one step.completed/run.completed, then silence", async () => {
		const harness = stormHarness();
		harness.put(
			envSetupView({
				step: "setup.author",
				attempt: 2,
				runs: [
					{ id: "run-author-1", attempt: 1, status: "expired" },
					{ id: "run-author-2", attempt: 2, status: "running" },
				],
			}),
		);
		// The baseline observation: a listing of the repository the bus has never
		// seen reports nothing.
		harness.bus.noteRepositoryListed(REPO);
		await waitUntil(() => harness.listings.length > 0);
		await sleep(20);
		expect(eventIds(harness)).toEqual([]);

		// The author step ran long enough that the server published more events
		// than the broker's per-subscriber queue holds - the permanent state of a
		// server that has been up through one workflow. Nothing changed in the
		// store, so this warm-up reports nothing.
		for (let index = 0; index < 8; index += 1) harness.progress();
		await sleep(30);
		expect(eventIds(harness)).toEqual([]);

		// The author run completed and the workflow entered the long effect. The
		// engine's drain commits progress for it, so the hub publishes
		// repository-level updates while the step runs.
		harness.put(
			envSetupView({
				step: "setup.validate",
				attempt: 1,
				runs: [
					{ id: "run-author-1", attempt: 1, status: "expired" },
					{ id: "run-author-2", attempt: 2, status: "completed" },
				],
			}),
		);
		harness.progress();
		await waitUntil(() => eventIds(harness).length > 0);
		// Eleven more committed effects during the same long step.
		for (let index = 0; index < 11; index += 1) {
			harness.progress();
			await sleep(15);
		}
		await sleep(50);
		expect(harness.stormed).toBe(false);
		expect(eventIds(harness)).toEqual([
			"step.entered",
			"step.completed",
			"run.completed",
		]);

		// The step leaves validate for approval: exactly one more transition, and
		// then silence again.
		harness.put(
			envSetupView({
				step: "setup.approval",
				attempt: 1,
				runs: [
					{ id: "run-author-1", attempt: 1, status: "expired" },
					{ id: "run-author-2", attempt: 2, status: "completed" },
				],
			}),
		);
		harness.progress();
		await waitUntil(() => eventIds(harness).length > 3);
		await sleep(40);
		harness.progress();
		await sleep(40);
		expect(harness.stormed).toBe(false);
		expect(eventIds(harness)).toEqual([
			"step.entered",
			"step.completed",
			"run.completed",
			"step.entered",
			"step.completed",
		]);
		harness.stop();
	});
});

describe("storm guards", () => {
	/** Warm the broker's per-subscriber queue past its capacity, which is the
	 * permanent state of a server that has been up through one workflow: from
	 * then on the bus's own subscription reports an overflow on every publish,
	 * and (before the re-lists were coalesced) that re-entered the bus inside the
	 * delivery. */
	async function saturateQueue(harness: StormHarness): Promise<void> {
		for (let index = 0; index < 6; index += 1) harness.progress();
		await sleep(30);
	}

	test("a start re-listed while it is being reported is recorded once", async () => {
		const harness = stormHarness();
		harness.put(envSetupView({ step: "setup.author", attempt: 1, runs: [] }));
		harness.bus.noteRepositoryListed(REPO);
		await waitUntil(() => harness.listings.length > 0);
		await sleep(20);
		await saturateQueue(harness);
		expect(eventIds(harness)).toEqual([]);

		// A second workflow appears in the baselined repository. Recording its
		// `workflow.started` publishes a frame, and that publish re-lists the
		// repository while this listing has not yet remembered the new id: the
		// identical event is a replay, not a second start.
		harness.put(
			envSetupView({
				workflowId: "env-setup-grid-allocation-backend-4",
				step: "setup.author",
				attempt: 1,
				runs: [],
			}),
		);
		harness.progress();
		await waitUntil(() => eventIds(harness).length > 0);
		await sleep(40);
		expect(harness.stormed).toBe(false);
		expect(eventIds(harness)).toEqual(["workflow.started"]);
		harness.stop();
	});

	test("a workflow over its event budget is rate-limited with one warning", async () => {
		const harness = stormHarness({
			maxEventsPerWindow: 2,
			eventWindowMs: 1_000,
		});
		const attention = (count: number): WorkflowView =>
			envSetupView({
				step: "setup.validate",
				attempt: 1,
				runs: [],
				attention: Array.from(
					{ length: count },
					(_, index) => `probe-${index + 1}`,
				),
			});
		harness.put(attention(1));
		harness.bus.noteRepositoryListed(REPO);
		await waitUntil(() => harness.listings.length > 0);
		await sleep(20);
		expect(eventIds(harness)).toEqual([]);

		// Two events fit the budget, the next two do not.
		for (const reasons of [2, 3, 4, 5]) {
			harness.put(attention(reasons));
			harness.progress();
			await sleep(20);
		}
		expect(eventIds(harness)).toEqual(["attention.raised", "attention.raised"]);

		// The window elapses: the events that were dropped inside it are reported
		// once, with the exact count, and the next event is recorded again.
		harness.clock += 1_000;
		harness.put(attention(6));
		harness.progress();
		await waitUntil(() => eventIds(harness).length > 2);
		await sleep(30);
		const events = harness.bus.readEvents({ limit: 50 }).events;
		expect(events.map((event) => event.id)).toEqual([
			"attention.raised",
			"attention.raised",
			"events.suppressed",
			"attention.raised",
		]);
		expect(events[2]?.payload).toEqual({
			count: 2,
			workflowId: "env-setup-grid-allocation-backend-3",
			windowMs: 1_000,
		});
		expect(events[2]?.severity).toBe("warning");
		expect(events[2]?.humanNeeded).toBe(false);
		harness.stop();
	});

	test("a waiting review still gets through a saturated budget", async () => {
		const harness = stormHarness({
			maxEventsPerWindow: 1,
			eventWindowMs: 60_000,
		});
		const step = (id: string): WorkflowView =>
			envSetupView({ step: id, attempt: 1, runs: [] });
		harness.put(step("core.implementation"));
		harness.bus.noteRepositoryListed(REPO);
		await waitUntil(() => harness.listings.length > 0);
		await sleep(20);

		// The single budget slot goes to the step transition; the developer's
		// waiting review is a human-needed event and is recorded anyway.
		harness.put(step("core.developer-review"));
		harness.progress();
		await waitUntil(() =>
			eventIds(harness).some((id) => id === "review.waiting"),
		);
		await sleep(30);
		expect(harness.stormed).toBe(false);
		expect(eventIds(harness)).toEqual(["step.entered", "review.waiting"]);
		// A pending developer question is the other human-needed event and gets
		// through the same way.
		harness.clock += 60_000;
		harness.put(
			envSetupView({
				step: "core.developer-review",
				attempt: 1,
				runs: [],
				questions: ["q-1"],
			}),
		);
		harness.progress();
		await waitUntil(() =>
			eventIds(harness).some((id) => id === "question.pending"),
		);
		await sleep(30);
		expect(eventIds(harness)).toContain("question.pending");
		harness.stop();
	});

	test("one transition is reported once whichever path observes it", async () => {
		const harness = stormHarness({ reconcileMs: 15 });
		harness.put(envSetupView({ step: "setup.author", attempt: 2, runs: [] }));
		harness.bus.noteRepositoryListed(REPO);
		await waitUntil(() => harness.listings.length > 0);
		await sleep(20);
		harness.put(envSetupView({ step: "setup.validate", attempt: 1, runs: [] }));

		// The stream event names the workflow ...
		harness.bus.noteWorkflowUpdated(
			REPO,
			"env-setup-grid-allocation-backend-3",
		);
		await waitUntil(() => eventIds(harness).length > 0);
		const afterStreamEvent = eventIds(harness);
		expect(afterStreamEvent).toEqual(["step.entered", "step.completed"]);

		// ... a repository refresh, the reconciliation tick and a plain listing all
		// observe the same projection afterwards, and none of them repeats it.
		harness.progress();
		await sleep(30);
		harness.bus.noteRepositoryListed(REPO);
		await sleep(40);
		expect(eventIds(harness)).toEqual(afterStreamEvent);
		expect(harness.stormed).toBe(false);
		harness.stop();
	});
});

describe("repository refresh cost", () => {
	test("a burst during a long step costs one re-list per debounce window", async () => {
		const harness = stormHarness();
		harness.put(envSetupView({ step: "setup.validate", attempt: 1, runs: [] }));
		harness.bus.noteRepositoryListed(REPO);
		await waitUntil(() => harness.listings.length > 0);
		await sleep(20);
		harness.listings.length = 0;
		// Twenty committed effects of one long step, plus the publishing the bus
		// itself does: the repository is read once, not once per event.
		for (let index = 0; index < 20; index += 1) harness.progress();
		await waitUntil(() => harness.listings.length > 0);
		await sleep(50);
		expect(harness.stormed).toBe(false);
		expect(harness.listings).toEqual([REPO]);
		expect(harness.listingDepth.max).toBe(1);
		harness.stop();
	});

	test("a re-list asked for while one is running is coalesced, never nested", async () => {
		const harness = stormHarness({ reentrantListing: true });
		harness.put(envSetupView({ step: "setup.validate", attempt: 1, runs: [] }));
		harness.bus.noteRepositoryListed(REPO);
		await waitUntil(() => harness.listings.length >= 2);
		await sleep(50);
		expect(harness.stormed).toBe(false);
		// One pass ran to completion, then exactly one follow-up pass for what asked
		// during it: the request was remembered, not nested and not queued.
		expect(harness.listingDepth.max).toBe(1);
		expect(harness.listings).toEqual([REPO, REPO]);
		harness.stop();
	});
});
