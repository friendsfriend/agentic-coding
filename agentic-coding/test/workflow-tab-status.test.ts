import { describe, expect, test } from "bun:test";
import {
	agentTabBaseLabel,
	agentTabGlyph,
	agentTabLabel,
	agentTabMatchesBase,
	aggregateAgentTabStatus,
	findAgentTabByBase,
} from "../src/workflow/tab-status.ts";

describe("agent tab status glyphs", () => {
	test("every run status has a distinct single-cell glyph", () => {
		const statuses = [
			"pending",
			"working",
			"completed",
			"blocked",
			"failed",
			"expired",
		] as const;
		const glyphs = statuses.map((status) => agentTabGlyph(status));
		expect(glyphs).toEqual(["○", "●", "✓", "■", "✗", "·"]);
		expect(new Set(glyphs).size).toBe(statuses.length);
		for (const glyph of glyphs) expect([...glyph]).toHaveLength(1);
	});

	test("unknown status falls back to the open glyph", () => {
		expect(agentTabGlyph("mystery")).toBe("○");
		expect(agentTabGlyph("")).toBe("○");
	});

	test("label prefixes the base with a single glyph and stays stable", () => {
		expect(agentTabLabel("worker", "working")).toBe("● worker");
		expect(agentTabLabel("worker", "completed")).toBe("✓ worker");
		// Re-rendering the same base never grows the prefix.
		expect(agentTabLabel(agentTabBaseLabel("○ worker"), "working")).toBe(
			"● worker",
		);
	});

	test("base label strips every glyph prefix", () => {
		expect(agentTabBaseLabel("● worker")).toBe("worker");
		expect(agentTabBaseLabel("✓ verification")).toBe("verification");
		expect(agentTabBaseLabel("■ dashboard")).toBe("dashboard");
		expect(agentTabBaseLabel("verification")).toBe("verification");
		expect(agentTabBaseLabel("dashboard")).toBe("dashboard");
		// Stale prefixes accumulate across releases; every one is recovered.
		expect(agentTabBaseLabel("● ● worker")).toBe("worker");
		expect(agentTabBaseLabel("○ ● ✓ verification")).toBe("verification");
	});

	test("matches a tab label to its base regardless of the status glyph", () => {
		expect(agentTabMatchesBase("● dashboard", "dashboard")).toBe(true);
		expect(agentTabMatchesBase("dashboard", "dashboard")).toBe(true);
		expect(agentTabMatchesBase("✓ dashboard", "git")).toBe(false);
		expect(agentTabMatchesBase(undefined, "dashboard")).toBe(false);
	});

	test("finds the first tab whose base label matches", () => {
		const tabs = [
			{ tab_id: "t1", label: "● worker" },
			{ tab_id: "t2", label: "○ dashboard" },
			{ tab_id: "t3", label: "dashboard" },
		];
		expect(findAgentTabByBase(tabs, "dashboard")?.tab_id).toBe("t2");
		expect(findAgentTabByBase(tabs, "worker")?.tab_id).toBe("t1");
		expect(findAgentTabByBase(tabs, "git")).toBeUndefined();
	});

	test("aggregation keeps outstanding work ahead of terminal states", () => {
		expect(aggregateAgentTabStatus(["completed", "working"])).toBe("working");
		expect(aggregateAgentTabStatus(["pending", "completed"])).toBe("pending");
		expect(aggregateAgentTabStatus(["completed", "failed"])).toBe("failed");
		expect(aggregateAgentTabStatus(["blocked", "completed"])).toBe("blocked");
		expect(aggregateAgentTabStatus(["completed", "expired"])).toBe("completed");
		expect(aggregateAgentTabStatus([])).toBe("expired");
		expect(aggregateAgentTabStatus(["mystery"])).toBe("pending");
	});
});
