// Shell workflow monitor (add-orchestrator-workflow-monitoring, tasks 2.1 and
// 2.2). One injected gateway emits events and serves views, so the monitor is
// exercised exactly as the shell wires it — minus the durable orchestrator
// host, whose delivery entry point is injected.

import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../src/contracts/environment.ts";
import type {
	DashboardGateway,
	GatewayEventHandlers,
} from "../src/contracts/gateway.ts";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import { startWorkflowMonitor } from "../src/tui/orchestrator/monitor.ts";

/** Contract-only view fixture: what the monitor reads, and nothing else. */
function view(
	workflowId: string,
	overrides: {
		status?: WorkflowView["status"];
		step?: string;
		startedBy?: WorkflowView["startedBy"];
		pendingQuestions?: number;
	} = {},
): WorkflowView {
	const step = overrides.step ?? "core.implementation";
	return {
		workflowId,
		status: overrides.status ?? "active",
		startedBy: overrides.startedBy ?? "orchestrator",
		currentStep: { id: step, label: step, attempt: 1, enteredAt: "" },
		effects: [],
		pendingQuestions: Array.from(
			{ length: overrides.pendingQuestions ?? 0 },
			(_, index) => ({ id: `q-${index}` }),
		),
		availableActions: [],
	} as unknown as WorkflowView;
}

const keyOf = (repo: string, workflowId: string) =>
	`${repo}\u0000${workflowId}`;

/** The slice of the gateway port the monitor uses. */
class FakeGateway {
	handlers: GatewayEventHandlers | undefined;
	readonly views = new Map<string, WorkflowView>();
	readonly viewCalls: string[] = [];
	readonly listCalls: string[] = [];
	subscribes = 0;
	unsubscribes = 0;

	subscribe(handlers: GatewayEventHandlers): () => void {
		this.subscribes += 1;
		this.handlers = handlers;
		return () => {
			this.unsubscribes += 1;
			this.handlers = undefined;
		};
	}

	async view(repo: string, workflowId: string): Promise<WorkflowView> {
		this.viewCalls.push(keyOf(repo, workflowId));
		const found = this.views.get(keyOf(repo, workflowId));
		if (!found) throw new Error(`no such workflow: ${workflowId}`);
		return found;
	}

	async listViews(repo: string): Promise<WorkflowView[]> {
		this.listCalls.push(repo);
		return [...this.views.entries()]
			.filter(([key]) => key.startsWith(`${repo}\u0000`))
			.map(([, value]) => value);
	}

	put(repo: string, value: WorkflowView): void {
		this.views.set(keyOf(repo, value.workflowId), value);
	}

	/** One `workflow.updated` envelope, addressed exactly like the server's. */
	event(repo: string, workflowId: string): void {
		this.handlers?.onEvent({
			instance: "test",
			sequence: 1,
			domain: "workflow",
			kind: "workflow.updated",
			resource: repo,
			runId: workflowId,
			at: new Date().toISOString(),
			payload: null,
		} satisfies EventEnvelope);
	}

	resync(reason = "gap"): void {
		this.handlers?.onResync(reason);
	}
}

/** Poll until `condition` holds or the deadline passes, so a timing assertion
 * is never a race against a loaded machine. */
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

/** Short windows: the production cadence is pinned separately below. */
const FAST = { debounceMs: 5, coalesceMs: 20, minNoteIntervalMs: 60 };

function harness(
	options: {
		mode?: "wake" | "notify" | "off";
		timings?: Partial<typeof FAST>;
	} = {},
) {
	const gateway = new FakeGateway();
	const notes: string[] = [];
	const notifications: string[] = [];
	const monitor = startWorkflowMonitor({
		gateway: gateway as unknown as DashboardGateway,
		mode: options.mode ?? "wake",
		timings: { ...FAST, ...options.timings },
		notify: (message) => notifications.push(message),
		deliver: async (note) => {
			notes.push(note);
		},
	});
	return { gateway, notes, notifications, monitor };
}

describe("monitor subscription", () => {
	test("off observes nothing at all", () => {
		const { gateway, notifications, notes, monitor } = harness({ mode: "off" });
		expect(gateway.subscribes).toBe(0);
		gateway.put("/repo", view("wf-1", { step: "core.plan-approval" }));
		// Even a hand-driven event reaches no handler: nothing is subscribed.
		gateway.event("/repo", "wf-1");
		expect(notifications).toEqual([]);
		expect(notes).toEqual([]);
		monitor.stop();
	});

	test("stop unsubscribes and drops a pending note", async () => {
		const { gateway, notes, monitor } = harness();
		gateway.put("/repo", view("wf-1"));
		gateway.event("/repo", "wf-1");
		await waitUntil(() => gateway.viewCalls.length === 1);
		gateway.put("/repo", view("wf-1", { step: "core.developer-review" }));
		gateway.event("/repo", "wf-1");
		monitor.stop();
		expect(gateway.unsubscribes).toBe(1);
		await sleep(40);
		expect(notes).toEqual([]);
	});

	test("the production cadence is the designed one", async () => {
		const { MONITOR_TIMINGS } = await import(
			"../src/tui/orchestrator/monitor.ts"
		);
		expect(MONITOR_TIMINGS.coalesceMs).toBe(10_000);
		expect(MONITOR_TIMINGS.minNoteIntervalMs).toBe(60_000);
	});
});

describe("monitor reads", () => {
	test("events are debounced per workflow: a burst is one read", async () => {
		const { gateway, monitor } = harness();
		gateway.put("/repo", view("wf-1"));
		for (let index = 0; index < 8; index += 1) gateway.event("/repo", "wf-1");
		await waitUntil(() => gateway.viewCalls.length === 1);
		await sleep(30);
		expect(gateway.viewCalls).toEqual([keyOf("/repo", "wf-1")]);
		monitor.stop();
	});

	test("only workflows the orchestrator started are observed", async () => {
		const { gateway, notes, notifications, monitor } = harness();
		gateway.put("/repo", view("dev-1", { startedBy: "developer" }));
		gateway.put(
			"/repo",
			view("wf-1", { step: "core.plan-approval", startedBy: "orchestrator" }),
		);
		gateway.event("/repo", "dev-1");
		gateway.event("/repo", "wf-1");
		await waitUntil(() => gateway.viewCalls.length === 2);
		await sleep(40);
		// The orchestrator-started workflow is only a baseline on first sight; the
		// developer-started one is never even baselined.
		expect(notes).toEqual([]);
		expect(notifications).toEqual([]);
		monitor.stop();
	});

	test("an unreadable view keeps the baseline instead of inventing a transition", async () => {
		const { gateway, notes, monitor } = harness();
		gateway.put("/repo", view("wf-1"));
		gateway.event("/repo", "wf-1");
		await waitUntil(() => gateway.viewCalls.length === 1);
		// The workflow is gone before the next read.
		gateway.views.clear();
		gateway.event("/repo", "wf-1");
		await waitUntil(() => gateway.viewCalls.length === 2);
		await sleep(40);
		expect(notes).toEqual([]);
		monitor.stop();
	});
});

describe("coalesced notes", () => {
	test("three transitions in one window produce one note listing all three", async () => {
		const { gateway, notes, notifications, monitor } = harness();
		for (const id of ["wf-1", "wf-2", "wf-3"]) {
			gateway.put("/repo", view(id));
			gateway.event("/repo", id);
		}
		await waitUntil(() => gateway.viewCalls.length === 3);
		for (const id of ["wf-1", "wf-2", "wf-3"]) {
			gateway.put("/repo", view(id, { step: "core.developer-review" }));
			gateway.event("/repo", id);
		}
		await waitUntil(() => notes.length === 1, 3_000);
		expect(notes).toHaveLength(1);
		const lines = (notes[0] ?? "").split("\n");
		expect(lines[0]).toBe("[workflow-monitor]");
		expect(lines).toHaveLength(4);
		for (const id of ["wf-1", "wf-2", "wf-3"])
			expect(notes[0]).toContain(`${id} → core.developer-review`);
		// Each waiting review raises its own notification.
		expect(notifications).toEqual([
			"wf-1: developer review waiting (core.developer-review)",
			"wf-2: developer review waiting (core.developer-review)",
			"wf-3: developer review waiting (core.developer-review)",
		]);
		monitor.stop();
	});

	test("a burst beyond the per-minute bound is merged into the next note", async () => {
		const { gateway, notes, monitor } = harness({
			timings: { coalesceMs: 10, minNoteIntervalMs: 120 },
		});
		gateway.put("/repo", view("wf-1"));
		gateway.event("/repo", "wf-1");
		await waitUntil(() => gateway.viewCalls.length === 1);
		// First transition: one note after the coalescing window.
		gateway.put("/repo", view("wf-1", { step: "core.developer-review" }));
		gateway.event("/repo", "wf-1");
		await waitUntil(() => notes.length === 1, 3_000);
		expect(notes).toHaveLength(1);
		// A second transition inside the per-minute bound must not produce a note
		// of its own; it waits, and the third joins it.
		gateway.put("/repo", view("wf-1", { status: "attention-required" }));
		gateway.event("/repo", "wf-1");
		await sleep(40);
		expect(notes).toHaveLength(1);
		gateway.put("/repo", view("wf-1", { status: "completed" }));
		gateway.event("/repo", "wf-1");
		await waitUntil(() => notes.length === 2, 3_000);
		expect(notes).toHaveLength(2);
		expect(notes[1]?.split("\n")).toHaveLength(3);
		expect(notes[1]).toContain("attention required");
		expect(notes[1]).toContain("completed");
		monitor.stop();
	});

	test("notify mode notifies but never submits input", async () => {
		const { gateway, notes, notifications, monitor } = harness({
			mode: "notify",
		});
		gateway.put("/repo", view("wf-1"));
		gateway.event("/repo", "wf-1");
		await waitUntil(() => gateway.viewCalls.length === 1);
		gateway.put("/repo", view("wf-1", { status: "attention-required" }));
		gateway.event("/repo", "wf-1");
		await sleep(60);
		expect(notes).toEqual([]);
		// attention-required is not a human decision, so it raises no notification
		// either: the session note is what would have reported it.
		expect(notifications).toEqual([]);
		// A review does notify in this mode.
		gateway.put("/repo", view("wf-1", { step: "core.plan-approval" }));
		gateway.event("/repo", "wf-1");
		await waitUntil(() => notifications.length === 1);
		expect(notes).toEqual([]);
		monitor.stop();
	});
});

describe("resync", () => {
	test("re-reads the orchestrator-started set of every known repository", async () => {
		const { gateway, notes, monitor } = harness();
		gateway.put("/repo", view("wf-1"));
		gateway.event("/repo", "wf-1");
		await waitUntil(() => gateway.viewCalls.length === 1);
		// A workflow that started while the shell was outside the replay window,
		// and a state change on one it already knew.
		gateway.put("/repo", view("wf-2", { step: "core.plan-approval" }));
		gateway.put("/repo", view("wf-1", { step: "core.developer-review" }));
		gateway.resync();
		await waitUntil(() => notes.length === 1, 3_000);
		expect(gateway.listCalls).toEqual(["/repo"]);
		// wf-2 is a first observation (silent); wf-1's review is the one transition.
		expect(notes).toHaveLength(1);
		expect(notes[0]?.split("\n")).toHaveLength(2);
		expect(notes[0]).toContain("wf-1 → core.developer-review");
		monitor.stop();
	});

	test("a repository no event has named is never listed", async () => {
		const { gateway, monitor } = harness();
		gateway.resync();
		await sleep(30);
		expect(gateway.listCalls).toEqual([]);
		monitor.stop();
	});
});

describe("delivery", () => {
	test("a note goes to the session as one follow-up, and a stopped monitor is silent", async () => {
		// The default delivery is the durable host; assert the seam the shell
		// relies on instead of spawning one: `deliver` receives one note per
		// coalescing window.
		const delivered: string[] = [];
		const gateway = new FakeGateway();
		const monitor = startWorkflowMonitor({
			gateway: gateway as unknown as DashboardGateway,
			mode: "wake",
			timings: { debounceMs: 5, coalesceMs: 10, minNoteIntervalMs: 0 },
			notify: () => {},
			deliver: async (note) => {
				delivered.push(note);
			},
		});
		gateway.put("/repo", view("wf-1"));
		gateway.event("/repo", "wf-1");
		await waitUntil(() => gateway.viewCalls.length === 1);
		gateway.put(
			"/repo",
			view("wf-1", { status: "completed", step: "core.completed" }),
		);
		gateway.event("/repo", "wf-1");
		await waitUntil(() => delivered.length === 1, 3_000);
		expect(delivered[0]).toBe(
			"[workflow-monitor]\n- wf-1 → core.completed (completed)",
		);
		monitor.stop();
		const before = delivered.length;
		gateway.event("/repo", "wf-1");
		await sleep(30);
		expect(delivered).toHaveLength(before);
	});
});
