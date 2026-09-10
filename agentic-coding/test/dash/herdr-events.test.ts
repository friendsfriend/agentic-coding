import { describe, expect, test } from "bun:test";
import {
	HERDR_DASHBOARD_EVENTS,
	herdrEventMatchesWorkspace,
	herdrEventRequest,
	parseHerdrEventLines,
} from "../../src/tui/dash/herdr-events";

describe("herdr dashboard event subscription", () => {
	test("request subscribes to every low-frequency lifecycle event", () => {
		const request = JSON.parse(herdrEventRequest().trim()) as {
			method: string;
			params: { subscriptions: Array<{ type: string }> };
		};
		expect(request.method).toBe("events.subscribe");
		expect(request.params.subscriptions.map((item) => item.type)).toEqual([
			...HERDR_DASHBOARD_EVENTS,
		]);
	});

	test("parses complete envelopes and keeps the partial trailing line", () => {
		const first = JSON.stringify({
			event: "tab_renamed",
			data: { workspace_id: "w1", tab_id: "w1:t1", label: "● worker" },
		});
		const second = JSON.stringify({
			event: "pane_agent_detected",
			data: { workspace_id: "w1", pane_id: "w1:p1" },
		});
		const parsed = parseHerdrEventLines(`${first}\n${second}\n{"event":"tab_`);
		expect(parsed.events).toHaveLength(2);
		expect(parsed.events[0]).toEqual({
			event: "tab_renamed",
			data: { workspace_id: "w1", tab_id: "w1:t1", label: "● worker" },
		});
		expect(parsed.events[1].event).toBe("pane_agent_detected");
		expect(parsed.rest).toBe('{"event":"tab_');
	});

	test("ignores the ack, malformed lines, and non-object payloads", () => {
		const lines = [
			'{"id":"s","result":{"type":"subscription_started"}}',
			"not json",
			'{"event":"tab_renamed","data":["array"]}',
			'{"event":"tab_renamed"}',
			"",
		].join("\n");
		expect(parseHerdrEventLines(lines).events).toEqual([]);
	});

	test("workspace filter keeps matching and unscoped events", () => {
		expect(herdrEventMatchesWorkspace({ workspace_id: "w1" }, "w1")).toBe(true);
		expect(herdrEventMatchesWorkspace({ workspace_id: "w2" }, "w1")).toBe(
			false,
		);
		expect(herdrEventMatchesWorkspace({ tab_id: "w1:t1" }, "w1")).toBe(true);
		expect(herdrEventMatchesWorkspace({ workspace_id: "w2" }, undefined)).toBe(
			true,
		);
	});
});
