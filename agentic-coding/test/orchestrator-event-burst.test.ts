// `[agents.orchestrator] event_burst_limit` and `event_burst_window_seconds`
// (fix-event-bus-storm): the bus's own rate limit, parsed, validated and
// defaulted beside the other file-only orchestrator bounds.
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_ORCHESTRATOR_EVENT_BURST_LIMIT,
	DEFAULT_ORCHESTRATOR_EVENT_BURST_WINDOW_SECONDS,
	MAX_ORCHESTRATOR_EVENT_BURST_LIMIT,
	MAX_ORCHESTRATOR_EVENT_BURST_WINDOW_SECONDS,
	orchestratorEventBurstLimit,
	orchestratorEventBurstWindowSeconds,
	parseAgentsConfig,
} from "../src/workflow/profiles.ts";

describe("[agents.orchestrator] event burst bounds", () => {
	test("parses positive integers and defaults to the bus's own budget", () => {
		expect(
			parseAgentsConfig({
				orchestrator: { event_burst_limit: 12, event_burst_window_seconds: 5 },
			}).orchestrator,
		).toEqual({ event_burst_limit: 12, event_burst_window_seconds: 5 });
		// A configuration that says nothing still suppresses a storm: the default
		// is the contract's own bound, not a second opinion about it.
		expect(orchestratorEventBurstLimit(undefined)).toBe(
			DEFAULT_ORCHESTRATOR_EVENT_BURST_LIMIT,
		);
		expect(orchestratorEventBurstWindowSeconds(undefined)).toBe(
			DEFAULT_ORCHESTRATOR_EVENT_BURST_WINDOW_SECONDS,
		);
		expect(
			orchestratorEventBurstLimit(
				parseAgentsConfig({ orchestrator: { event_burst_limit: 7 } }),
			),
		).toBe(7);
		expect(
			orchestratorEventBurstWindowSeconds(
				parseAgentsConfig({ orchestrator: { event_burst_window_seconds: 2 } }),
			),
		).toBe(2);
	});

	test("refuses a zero, a negative, a fraction, an oversized value and a typo", () => {
		for (const value of [0, -5, 1.5, MAX_ORCHESTRATOR_EVENT_BURST_LIMIT + 1])
			expect(() =>
				parseAgentsConfig({ orchestrator: { event_burst_limit: value } }),
			).toThrow("event_burst_limit must be a positive integer");
		for (const value of [
			0,
			-1,
			2.5,
			MAX_ORCHESTRATOR_EVENT_BURST_WINDOW_SECONDS + 1,
		])
			expect(() =>
				parseAgentsConfig({
					orchestrator: { event_burst_window_seconds: value },
				}),
			).toThrow("event_burst_window_seconds must be a positive integer");
		expect(() =>
			parseAgentsConfig({ orchestrator: { event_burst_limits: 5 } }),
		).toThrow("unsupported key event_burst_limits");
	});
});
