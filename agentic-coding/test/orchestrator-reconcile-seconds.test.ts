// `[agents.orchestrator] reconcile_seconds` (fix-event-bus-missed-transitions):
// parse, validate and default beside the stall-minutes tests. The key is
// file-only, like `limits` and `stall_minutes`.
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_ORCHESTRATOR_RECONCILE_SECONDS,
	MAX_ORCHESTRATOR_RECONCILE_SECONDS,
	orchestratorReconcileSeconds,
	parseAgentsConfig,
} from "../src/workflow/profiles.ts";

describe("[agents.orchestrator] reconcile_seconds", () => {
	test("parses a positive integer and defaults to 30", () => {
		expect(
			parseAgentsConfig({ orchestrator: { reconcile_seconds: 45 } })
				.orchestrator,
		).toEqual({ reconcile_seconds: 45 });
		expect(orchestratorReconcileSeconds(undefined)).toBe(
			DEFAULT_ORCHESTRATOR_RECONCILE_SECONDS,
		);
		expect(
			orchestratorReconcileSeconds(parseAgentsConfig({ orchestrator: {} })),
		).toBe(DEFAULT_ORCHESTRATOR_RECONCILE_SECONDS);
		expect(
			orchestratorReconcileSeconds(
				parseAgentsConfig({ orchestrator: { reconcile_seconds: 60 } }),
			),
		).toBe(60);
	});

	test("refuses a zero, a negative, a fraction, an oversized value and an unknown key", () => {
		for (const value of [0, -5, 1.5, MAX_ORCHESTRATOR_RECONCILE_SECONDS + 1])
			expect(() =>
				parseAgentsConfig({ orchestrator: { reconcile_seconds: value } }),
			).toThrow("reconcile_seconds must be a positive integer");
		expect(() =>
			parseAgentsConfig({ orchestrator: { reconcile_second: 5 } }),
		).toThrow("unsupported key reconcile_second");
	});
});
