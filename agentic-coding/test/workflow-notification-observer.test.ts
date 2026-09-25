// Developer-action notification observer tests
// (workflow-developer-notifications, tasks 3.1, 3.2, 3.4): baseline/notify-once
// transitions, retained blocked obligations, coalescing, enabled gating, and
// presentation-only non-interference.
import { describe, expect, test } from "bun:test";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import type { HerdrPort } from "../src/workflow/adapters.ts";
import {
	NOTIFICATION_FALLBACK_REFRESH_MS,
	viewAgentRequiresInput,
	WorkflowNotifications,
} from "../src/workflow/notification-observer.ts";
import { BoundedNotificationDiagnostics } from "../src/workflow/notification-sync.ts";
import type { SidebarObservation } from "../src/workflow/sidebar.ts";

function view(overrides: {
	workflowId?: string;
	status?: WorkflowView["status"];
	actions?: Array<{ id: string; requiresInput?: boolean }>;
	pendingRunIds?: string[];
	workspace?: string;
	repository?: string;
	paneId?: string;
}): WorkflowView {
	return {
		workflowId: overrides.workflowId ?? "wf",
		changeId: "wf",
		revision: 4,
		definition: { id: "openspec-full", version: 1, digest: "d", label: "Full" },
		status: overrides.status ?? "active",
		repository: overrides.repository ?? "/projects/agentic-coding",
		worktree: overrides.repository ?? "/projects/agentic-coding",
		branch: "feature/x",
		baseCommit: "abc",
		...(overrides.workspace ? { workspace: overrides.workspace } : {}),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		currentStep: {
			id: "core.implementation",
			label: "Implementation",
			attempt: 1,
			enteredAt: "2026-01-01T00:00:00.000Z",
		},
		runs: [
			{
				id: "run-1",
				stepId: "core.implementation",
				role: "worker",
				attempt: 1,
				status: "working",
				runtime: "pi",
				profile: "default",
				paneId: overrides.paneId ?? "w1:p1",
			},
		],
		routing: { defaultProfile: "default", routes: [] },
		effects: [
			{ id: "e1", kind: "agent.launch", status: "pending", attempts: 1 },
		],
		observations: [],
		health: { valid: true, attention: [] },
		pendingQuestions: (overrides.pendingRunIds ?? []).map((runId, index) => ({
			id: `q${index}`,
			workflowId: overrides.workflowId ?? "wf",
			runId,
			stepId: "core.implementation",
			role: "worker",
			description: "?",
			options: [],
			status: "pending" as const,
			createdAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2099-01-01T00:00:00.000Z",
		})),
		availableActions: (overrides.actions ?? []).map((action) => ({
			id: action.id,
			label: action.id,
			confirmation: "confirm" as const,
			...(action.requiresInput ? { requiresInput: true } : {}),
		})),
	};
}

interface FakeState {
	agentStatus?: string;
	agentPresent?: boolean;
	tabLabel?: string;
}

function fakeHerdr(state: FakeState = {}): {
	herdr: HerdrPort;
	calls: string[][];
} {
	const calls: string[][] = [];
	const herdr: HerdrPort = {
		call(...args: string[]) {
			calls.push(args);
			if (args[0] === "agent" && args[1] === "list") {
				if (state.agentPresent === false) return { agents: [] };
				return {
					agents: [
						{
							pane_id: "w1:p1",
							agent: "pi",
							agent_status: state.agentStatus ?? "idle",
						},
					],
				};
			}
			if (args[0] === "pane" && args[1] === "list")
				return {
					panes: [
						{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "idle" },
					],
				};
			if (args[0] === "workspace" && args[1] === "list")
				return {
					workspaces: [{ workspace_id: "w1", label: "agentic-coding" }],
				};
			if (args[0] === "tab" && args[1] === "list")
				return {
					tabs: [{ tab_id: "w1:t1", label: state.tabLabel ?? "dashboard" }],
				};
			return {};
		},
	};
	return { herdr, calls };
}

const notificationCalls = (calls: string[][]): string[][] =>
	calls.filter((args) => args[0] === "notification" && args[1] === "show");

describe("notification observer transitions (task 3.1)", () => {
	test("records a baseline then notifies once per new obligation", async () => {
		const { herdr, calls } = fakeHerdr({ agentStatus: "idle" });
		let current = view({ status: "paused", workspace: "w1" });
		const owner = new WorkflowNotifications({
			enabled: () => true,
			herdr,
			views: () => [current],
		});
		// First observation already owes input: no replay notification.
		await owner.reconcile();
		expect(notificationCalls(calls)).toHaveLength(0);
		// Clear, then owe again: exactly one notification.
		current = view({ status: "active", workspace: "w1" });
		await owner.reconcile();
		current = view({ status: "paused", workspace: "w1" });
		await owner.reconcile();
		expect(notificationCalls(calls)).toHaveLength(1);
		// Repeated refresh while still owed: no additional notification.
		await owner.reconcile();
		expect(notificationCalls(calls)).toHaveLength(1);
		owner.dispose();
	});

	test("the focus calls precede the notification it accompanies", async () => {
		const { herdr, calls } = fakeHerdr({ agentStatus: "idle" });
		let current = view({ status: "active", workspace: "w1" });
		const owner = new WorkflowNotifications({
			enabled: () => true,
			herdr,
			views: () => [current],
		});
		await owner.reconcile();
		current = view({ status: "paused", workspace: "w1" });
		await owner.reconcile();
		const notificationIndex = calls.findIndex(
			(args) => args[0] === "notification" && args[1] === "show",
		);
		const focusIndex = calls.findIndex((args) => args[1] === "focus");
		expect(notificationIndex).toBeGreaterThanOrEqual(0);
		expect(focusIndex).toBeGreaterThanOrEqual(0);
		expect(focusIndex).toBeLessThan(notificationIndex);
		owner.dispose();
	});

	test("workflows sharing an id across repositories notify independently", async () => {
		const { herdr, calls } = fakeHerdr({ agentStatus: "idle" });
		let views = [
			view({ workflowId: "x", repository: "/a", status: "active" }),
			view({ workflowId: "x", repository: "/b", status: "active" }),
		];
		const owner = new WorkflowNotifications({
			enabled: () => true,
			herdr,
			views: () => views,
		});
		// Both baseline as not owed.
		await owner.reconcile();
		views = [
			view({ workflowId: "x", repository: "/a", status: "paused" }),
			view({ workflowId: "x", repository: "/b", status: "paused" }),
		];
		await owner.reconcile();
		// A bare-id transition map would record only one of the two.
		expect(notificationCalls(calls)).toHaveLength(2);
		owner.dispose();
	});

	test("a committed pending question on the current run raises a notification", async () => {
		const { herdr, calls } = fakeHerdr({ agentStatus: "idle" });
		let current = view({});
		const owner = new WorkflowNotifications({
			enabled: () => true,
			herdr,
			views: () => [current],
		});
		await owner.reconcile();
		current = view({ pendingRunIds: ["run-1"] });
		await owner.reconcile();
		expect(notificationCalls(calls)).toHaveLength(1);
		owner.dispose();
	});

	test("a question on a superseded run does not owe input", () => {
		const target = view({ pendingRunIds: ["run-old"] });
		const idle: SidebarObservation = {
			paneId: "w1:p1",
			status: "idle",
			fresh: true,
		};
		expect(
			viewAgentRequiresInput(
				target,
				new Map([["w1:p1", idle]]),
				new Set(),
				new Set(),
			),
		).toBe(false);
	});

	test("coalesces overlapping refreshes into one notification", async () => {
		const { herdr, calls } = fakeHerdr({ agentStatus: "idle" });
		let current = view({ status: "active", workspace: "w1" });
		const owner = new WorkflowNotifications({
			enabled: () => true,
			herdr,
			views: () => [current],
		});
		await owner.reconcile();
		current = view({ status: "paused", workspace: "w1" });
		await Promise.all([
			owner.reconcile(),
			owner.reconcile(),
			owner.reconcile(),
		]);
		expect(notificationCalls(calls)).toHaveLength(1);
		owner.dispose();
	});

	test("a cleared workflow reappears owing and re-arms across a vanish", async () => {
		const { herdr, calls } = fakeHerdr({ agentStatus: "idle" });
		let views: WorkflowView[] = [view({ status: "paused", workspace: "w1" })];
		const owner = new WorkflowNotifications({
			enabled: () => true,
			herdr,
			views: () => views,
		});
		// Baseline while owed, then clear, then vanish, then reappear owing.
		await owner.reconcile();
		views = [view({ status: "active", workspace: "w1" })];
		await owner.reconcile();
		views = [];
		await owner.reconcile();
		views = [view({ status: "paused", workspace: "w1" })];
		await owner.reconcile();
		expect(notificationCalls(calls)).toHaveLength(1);
		owner.dispose();
	});

	test("the fallback interval is bounded and disabled-safe", async () => {
		expect(NOTIFICATION_FALLBACK_REFRESH_MS).toBe(2000);
		const { herdr, calls } = fakeHerdr({ agentStatus: "idle" });
		const owner = new WorkflowNotifications({
			enabled: () => false,
			herdr,
			views: () => [view({ status: "paused", workspace: "w1" })],
			refreshMs: 5,
		});
		expect(owner.enabled).toBe(false);
		owner.start();
		await Bun.sleep(20);
		await expect(owner.reconcile()).resolves.toBeUndefined();
		expect(calls).toHaveLength(0);
		owner.dispose();
	});

	test("start schedules the periodic refresh and dispose stops it", async () => {
		const { herdr, calls } = fakeHerdr({ agentStatus: "idle" });
		let current = view({ status: "active", workspace: "w1" });
		const owner = new WorkflowNotifications({
			enabled: () => true,
			herdr,
			views: () => [current],
			refreshMs: 5,
		});
		owner.start();
		// The timer records the not-owed baseline on its own.
		await Bun.sleep(15);
		current = view({ status: "paused", workspace: "w1" });
		await Bun.sleep(20);
		expect(notificationCalls(calls)).toHaveLength(1);
		owner.dispose();
		const stopped = notificationCalls(calls).length;
		current = view({ status: "active", workspace: "w1" });
		await Bun.sleep(20);
		current = view({ status: "paused", workspace: "w1" });
		await Bun.sleep(20);
		expect(notificationCalls(calls)).toHaveLength(stopped);
	});
});

describe("live observation mapping (task 3.2)", () => {
	test("maps blocked and non-blocked statuses to the agent obligation", () => {
		const target = view({});
		const blocked: SidebarObservation = {
			paneId: "w1:p1",
			status: "blocked",
			fresh: true,
		};
		expect(
			viewAgentRequiresInput(
				target,
				new Map([["w1:p1", blocked]]),
				new Set(),
				new Set(),
			),
		).toBe(true);
		const idle: SidebarObservation = {
			paneId: "w1:p1",
			status: "idle",
			fresh: true,
		};
		expect(
			viewAgentRequiresInput(
				target,
				new Map([["w1:p1", idle]]),
				new Set(),
				new Set(),
			),
		).toBe(false);
	});

	test("a retained blocked observation survives a missing read and a fresh non-blocked clears it", () => {
		const target = view({});
		// Retained: the pane disappeared from the read but was previously blocked.
		const retained = new Set(["w1:p1"]);
		const next = new Set<string>();
		expect(viewAgentRequiresInput(target, new Map(), retained, next)).toBe(
			true,
		);
		expect(next.has("w1:p1")).toBe(true);
		// Fresh non-blocked evidence clears the obligation and the retained set.
		const cleared = new Set<string>();
		const idle: SidebarObservation = {
			paneId: "w1:p1",
			status: "idle",
			fresh: true,
		};
		expect(
			viewAgentRequiresInput(
				target,
				new Map([["w1:p1", idle]]),
				retained,
				cleared,
			),
		).toBe(false);
		expect(cleared.has("w1:p1")).toBe(false);
	});

	test("a blocked observation retains through a later missing observation end to end", async () => {
		const state: FakeState = { agentStatus: "idle", agentPresent: true };
		const { herdr, calls } = fakeHerdr(state);
		const owner = new WorkflowNotifications({
			enabled: () => true,
			herdr,
			views: () => [view({ workspace: "w1" })],
		});
		await owner.reconcile();
		state.agentStatus = "blocked";
		await owner.reconcile();
		expect(notificationCalls(calls)).toHaveLength(1);
		// The agent disappears from the read; the retained obligation must keep
		// the workflow owed so a later blocked read does not re-notify.
		state.agentPresent = false;
		await owner.reconcile();
		state.agentPresent = true;
		state.agentStatus = "blocked";
		await owner.reconcile();
		expect(notificationCalls(calls)).toHaveLength(1);
		owner.dispose();
	});

	test("a pane absent from the live set is skipped even when retained", () => {
		const target = view({});
		const retained = new Set(["w1:p1"]);
		expect(
			viewAgentRequiresInput(target, new Map(), retained, new Set(), new Set()),
		).toBe(false);
		expect(
			viewAgentRequiresInput(
				target,
				new Map(),
				retained,
				new Set(),
				new Set(["w1:p1"]),
			),
		).toBe(true);
	});
});

describe("presentation-only non-interference (task 3.4)", () => {
	test("a failed observation leaves the view untouched with one bounded diagnostic", async () => {
		const messages: string[] = [];
		const failing: HerdrPort = {
			call() {
				throw new Error("herdr unavailable");
			},
		};
		const target = view({ status: "paused", workspace: "w1" });
		const before = JSON.stringify(target);
		const owner = new WorkflowNotifications({
			enabled: () => true,
			herdr: failing,
			views: () => [target],
			diagnostics: new BoundedNotificationDiagnostics((message) =>
				messages.push(message),
			),
		});
		await expect(owner.reconcile()).resolves.toBeUndefined();
		await owner.reconcile();
		await owner.reconcile();
		expect(messages).toEqual(["workflow notifications: herdr unavailable"]);
		expect(JSON.stringify(target)).toBe(before);
		expect(target.revision).toBe(4);
		expect(target.effects[0]?.attempts).toBe(1);
		expect(target.effects[0]?.status).toBe("pending");
		owner.dispose();
	});

	test("a failed focus reports one bounded diagnostic without failing the notification", async () => {
		const messages: string[] = [];
		const { herdr, calls } = fakeHerdr({
			agentStatus: "idle",
			tabLabel: "worker",
		});
		let current = view({ status: "active", workspace: "w1" });
		const owner = new WorkflowNotifications({
			enabled: () => true,
			herdr,
			views: () => [current],
			diagnostics: new BoundedNotificationDiagnostics((message) =>
				messages.push(message),
			),
		});
		await owner.reconcile();
		current = view({ status: "paused", workspace: "w1" });
		await owner.reconcile();
		expect(notificationCalls(calls)).toHaveLength(1);
		expect(messages).toEqual([
			"workflow notifications: dashboard focus skipped for workspace w1",
		]);
		owner.dispose();
	});
});
