// The dashboard safety resync depends on `loadDashboard` forwarding `refresh`
// into the cache. Without that link a forced read would be served from a stale
// cache entry, so a missed event could never recover even though the timer and
// the cache both behave correctly in isolation. This pins the link end to end
// at the data-layer boundary.
import { afterEach, expect, test } from "bun:test";
import type { ObservationRequest } from "../../src/contracts/environment.ts";
import type { DashboardGateway } from "../../src/contracts/gateway.ts";
import { testDashboard } from "../../src/tui/dash/demo.ts";
import { loadArtifacts } from "../../src/tui/data/git.ts";
import { clearGateway, configureGateway } from "../../src/tui/data/index.ts";
import {
	loadDashboard,
	mergeDashboardLive,
} from "../../src/tui/data/workflow.ts";

afterEach(() => clearGateway());

test("loadArtifacts re-reads the gateway when refresh is requested", async () => {
	let observes = 0;
	configureGateway({
		observe: async (observation: ObservationRequest) => {
			if (observation.kind !== "artifacts") throw new Error("unexpected read");
			observes += 1;
			return observes === 1 ? [] : ["proposal.md"];
		},
	} as unknown as DashboardGateway);
	const state = testDashboard().state;

	await loadArtifacts(state);
	await loadArtifacts(state);
	expect(observes).toBe(1);

	await loadArtifacts(state, undefined, { refresh: true });
	expect(observes).toBe(2);
	expect(await loadArtifacts(state)).toEqual(["proposal.md"]);
});

test("loadDashboard re-reads the gateway only when refresh is requested", async () => {
	let observes = 0;
	configureGateway({
		observe: async () => {
			observes += 1;
			return testDashboard();
		},
	} as unknown as DashboardGateway);

	// A plain read is cached: a second call does not reach the gateway.
	await loadDashboard("/repo", "wf-1");
	await loadDashboard("/repo", "wf-1");
	expect(observes).toBe(1);

	// A forced read bypasses the cached value and reaches the gateway again.
	await loadDashboard("/repo", "wf-1", undefined, { refresh: true });
	expect(observes).toBe(2);
});

test("a live view overlay keeps the heavy dashboard fields", () => {
	const current = testDashboard();
	current.state = {
		...current.state,
		revision: 7,
		status: "working",
		ticket: "T-1",
		stage: "build",
	};
	current.request = "full request";
	current.agents = [
		{
			role: "worker",
			status: "working",
			runId: "run-1",
			cost: 12,
			metrics: { inputTokens: 100, outputTokens: 20 },
		},
	];
	current.events = [{ at: "2026-01-01T00:00:00Z", event: "measured" }];
	current.health = { dirty: true, ahead: 2, behind: 0, branch: "main" };

	const live = testDashboard();
	live.state = {
		...live.state,
		revision: 8,
		status: "blocked",
	};
	live.request = "live request";
	live.agents = [
		{ role: "worker", status: "blocked", runId: "run-1", model: "new-model" },
	];
	live.updated = "2026-01-01T00:01:00Z";
	live.age = "1 minute";
	live.events = [];
	live.health = { dirty: false, ahead: 0, behind: 0, branch: "" };

	const merged = mergeDashboardLive(current, live);
	expect(merged.state.revision).toBe(8);
	expect(merged.state.status).toBe("blocked");
	// The live view does not carry the plan-stage fields; the full state does.
	expect(merged.state.ticket).toBe("T-1");
	expect(merged.state.stage).toBe("build");
	expect(merged.request).toBe("live request");
	expect(merged.agents[0]).toMatchObject({
		runId: "run-1",
		status: "blocked",
		model: "new-model",
		// Usage belongs to the full observation; the view read must not erase it.
		cost: 12,
		metrics: { inputTokens: 100, outputTokens: 20 },
	});
	expect(merged.events).toBe(current.events);
	expect(merged.health).toBe(current.health);
	expect(merged.updated).toBe("2026-01-01T00:01:00Z");
	expect(merged.age).toBe("1 minute");
});
