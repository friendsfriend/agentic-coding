// `[agents.orchestrator] stall_minutes` (add-orchestrator-event-subscriptions,
// task 5.3): parse, validate and default beside the monitor-mode tests.
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_ORCHESTRATOR_STALL_MINUTES,
	MAX_ORCHESTRATOR_STALL_MINUTES,
	orchestratorStallMinutes,
	parseAgentsConfig,
} from "../src/workflow/profiles.ts";

describe("[agents.orchestrator] stall_minutes", () => {
	test("parses a positive integer and defaults to 30", () => {
		expect(
			parseAgentsConfig({ orchestrator: { stall_minutes: 5 } }).orchestrator,
		).toEqual({ stall_minutes: 5 });
		expect(orchestratorStallMinutes(undefined)).toBe(
			DEFAULT_ORCHESTRATOR_STALL_MINUTES,
		);
		expect(
			orchestratorStallMinutes(parseAgentsConfig({ orchestrator: {} })),
		).toBe(DEFAULT_ORCHESTRATOR_STALL_MINUTES);
		expect(
			orchestratorStallMinutes(
				parseAgentsConfig({ orchestrator: { stall_minutes: 90 } }),
			),
		).toBe(90);
	});

	test("refuses a zero, a negative, a fraction, an oversized value and an unknown key", () => {
		for (const value of [0, -5, 1.5, MAX_ORCHESTRATOR_STALL_MINUTES + 1])
			expect(() =>
				parseAgentsConfig({ orchestrator: { stall_minutes: value } }),
			).toThrow("stall_minutes must be a positive integer");
		expect(() =>
			parseAgentsConfig({ orchestrator: { stall_minutess: 5 } }),
		).toThrow("unsupported key stall_minutess");
	});
});
