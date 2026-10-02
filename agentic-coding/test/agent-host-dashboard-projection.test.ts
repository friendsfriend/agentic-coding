// add-pi-durable-runtime: the dashboard Agents panel needs a durable run's
// host socket and conversation id to open the agent session view instead of
// focusing a (nonexistent) pane. Pins the projection end to end from a
// `WorkflowView` run through `loadDashboardSeed`'s `DashboardData.agents[]`.
import { afterEach, expect, test } from "bun:test";
import type { DashboardGateway } from "../src/contracts/gateway.ts";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import { clearGateway, configureGateway } from "../src/tui/data/index.ts";
import { loadDashboardSeed } from "../src/tui/data/workflow.ts";

afterEach(() => clearGateway());

const baseView = {
	workflowId: "wf-durable",
	changeId: "",
	revision: 1,
	definition: { id: "core", version: 1, digest: "d", label: "Core" },
	status: "active",
	repository: "/repo",
	worktree: "/repo",
	branch: "main",
	baseCommit: "abc",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	task: "durable task",
	currentStep: {
		id: "core.implementation",
		label: "Implementation",
		attempt: 1,
		enteredAt: "2026-01-01T00:00:00.000Z",
	},
	routing: {},
	effects: [],
	observations: [],
	health: { valid: true, attention: [] },
	availableActions: [],
} as const;

test("a pi-durable run surfaces its host socket and conversation id to the Agents panel", async () => {
	const view: WorkflowView = {
		...baseView,
		runs: [
			{
				id: "run-1",
				stepId: "core.implementation",
				role: "worker",
				attempt: 1,
				status: "working",
				runtime: "pi-durable",
				profile: "durable-default",
				hostSocket: "/tmp/workflow/agent-host/host.sock",
				conversationId: "7",
			},
		],
	} as unknown as WorkflowView;
	configureGateway({ view: async () => view } as unknown as DashboardGateway);
	const seed = await loadDashboardSeed("/repo", "wf-durable");
	const agent = seed?.agents.find((item) => item.role === "worker");
	expect(agent?.runtime).toBe("pi-durable");
	expect(agent?.runId).toBe("run-1");
	expect(agent?.hostSocket).toBe("/tmp/workflow/agent-host/host.sock");
	expect(agent?.conversationId).toBe("7");
});

test("a pane-based run carries no host socket or conversation id", async () => {
	const view: WorkflowView = {
		...baseView,
		runs: [
			{
				id: "run-2",
				stepId: "core.implementation",
				role: "worker",
				attempt: 1,
				status: "working",
				runtime: "pi",
				profile: "pi-default",
				paneId: "pane-1",
			},
		],
	} as unknown as WorkflowView;
	configureGateway({ view: async () => view } as unknown as DashboardGateway);
	const seed = await loadDashboardSeed("/repo", "wf-durable");
	const agent = seed?.agents.find((item) => item.role === "worker");
	expect(agent?.hostSocket).toBeUndefined();
	expect(agent?.conversationId).toBeUndefined();
});
