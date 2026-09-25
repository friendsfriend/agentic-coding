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
import { loadDashboard } from "../../src/tui/data/workflow.ts";

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
