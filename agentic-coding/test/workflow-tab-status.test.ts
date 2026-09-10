import { describe, expect, test } from "bun:test";
import {
	agentTabBaseLabel,
	agentTabGlyph,
	agentTabLabel,
	aggregateAgentTabStatus,
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

	test("base label strips exactly one known glyph prefix", () => {
		expect(agentTabBaseLabel("● worker")).toBe("worker");
		expect(agentTabBaseLabel("verification")).toBe("verification");
		expect(agentTabBaseLabel("dashboard")).toBe("dashboard");
		// A second glyph is not part of the recovered base's prefix semantics.
		expect(agentTabBaseLabel("● ● worker")).toBe("● worker");
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
