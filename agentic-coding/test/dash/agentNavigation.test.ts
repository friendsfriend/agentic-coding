import { expect, test } from "bun:test";
import {
	focusDashboardAgent,
	focusedAgentPosition,
	indexDashboardAgents,
} from "../../src/tui/dash/agent-navigation.ts";
import { testDashboard } from "../../src/tui/dash/demo.ts";

test("historical focus adds only the authoritative exact run without modifying latest-role rows", () => {
	const data = testDashboard("apply");
	data.state.runs = [
		{
			id: "old",
			stepId: "apply",
			role: "worker",
			attempt: 1,
			status: "completed",
			runtime: "pi",
			profile: "default",
		},
	];
	data.agents = [
		{
			role: "worker",
			runId: "new",
			status: "working",
			hostSocket: "/new.sock",
			conversationId: "new",
		},
	];
	const index = indexDashboardAgents(data);
	const focused = focusDashboardAgent(data, index, "old");
	expect(focused.agents).toEqual([
		{ role: "worker", runId: "old", status: "completed" },
		data.agents[0],
	]);
	expect(data.agents).toHaveLength(1);
	expect(focusedAgentPosition(index, "old")).toBe(0);
	expect(focusedAgentPosition(index, "new")).toBe(0);
	expect(focusedAgentPosition(index, "removed")).toBe(-1);
	expect(focusDashboardAgent(data, index, "removed")).toBe(data);
	expect(focusDashboardAgent(data, index, "new")).toBe(data);
});

test("requests and pending-role membership reuse observation indexes without searching history or row status", () => {
	const data = testDashboard("apply");
	const runs = Array.from({ length: 10000 }, (_, i) => ({
		id: `run-${i}`,
		stepId: "apply",
		role: "worker",
		attempt: i,
		status: "completed" as const,
		runtime: "pi",
		profile: "default",
	}));
	let historyReads = 0;
	let statusReads = 0;
	Object.defineProperty(data.state, "runs", {
		get: () => {
			historyReads++;
			return runs;
		},
	});
	data.agents = [
		{
			role: "worker",
			runId: "run-9999",
			get status() {
				statusReads++;
				return "working" as const;
			},
		},
		{ role: "reviewer", status: "completed" },
	];
	const index = indexDashboardAgents(data);
	const statusReadsAfterObservation = statusReads;
	for (let i = 0; i < 1000; i++) {
		expect(index.runsById.get(`run-${i}`)?.attempt).toBe(i);
		expect(focusedAgentPosition(index, `run-${i}`)).toBe(0);
		expect(index.pendingRoles.has("worker")).toBe(true);
		expect(index.pendingRoles.has("reviewer")).toBe(false);
	}
	focusDashboardAgent(data, index, "run-12");
	expect(historyReads).toBe(1);
	expect(statusReads).toBe(statusReadsAfterObservation);
	const next = {
		...data,
		state: { ...data.state, runs: [] },
		agents: [{ role: "worker", status: "completed" as const }],
	};
	const updated = indexDashboardAgents(next);
	expect(updated.runsById.has("run-12")).toBe(false);
	expect(updated.pendingRoles.has("worker")).toBe(false);
});
