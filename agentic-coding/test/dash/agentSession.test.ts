import { describe, expect, test } from "bun:test";
import { renderAgentSessionSummary } from "../../src/tui/dash/agent-session.ts";

describe("renderAgentSessionSummary", () => {
	test("idle with no live document reads as idle, zero entries", () => {
		const text = renderAgentSessionSummary({ entries: [] });
		expect(text).toContain("**Status:** idle");
		expect(text).toContain("**Transcript entries:** 0");
	});

	test("a live run with a running tool reports working and the tool name", () => {
		const text = renderAgentSessionSummary({
			entries: [{}, {}, {}],
			docs: {
				"pi.live": {
					run: { taskId: "t1", inputs: ["s1"] },
					tools: [{ name: "bash", status: "running" }],
				},
			},
		});
		expect(text).toContain("**Status:** working");
		expect(text).toContain("**Running tool:** bash");
		expect(text).toContain("**Transcript entries:** 3");
	});

	test("queued inbox items are reported", () => {
		const text = renderAgentSessionSummary({
			entries: [],
			docs: { "pi.inbox": { items: [{ id: "s1" }, { id: "s2" }] } },
		});
		expect(text).toContain("**Queued submissions:** 2");
	});

	test("degrades to a bounded fallback instead of throwing on an unexpected shape", () => {
		expect(renderAgentSessionSummary(null)).toBe("No session data yet.");
		expect(renderAgentSessionSummary("not an object")).toBe(
			"No session data yet.",
		);
		expect(() =>
			renderAgentSessionSummary({ docs: { "pi.live": "not an object" } }),
		).not.toThrow();
	});
});
