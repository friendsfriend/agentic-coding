import { describe, expect, test } from "bun:test";
import {
	agentTabBaseLabel,
	agentTabGlyph,
	agentTabLabel,
	agentTabMatchesBase,
	agentTabRoleName,
	aggregateAgentTabStatus,
	findAgentTabByBase,
	latestStatusesByTab,
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

	test("verifier role names compress to a short tab base", () => {
		expect(agentTabRoleName("quality-verifier")).toBe("quality-v…");
		expect(agentTabRoleName("security-verifier")).toBe("security-v…");
		expect(agentTabRoleName("performance-verifier")).toBe("performance-v…");
		expect(agentTabRoleName("test-quality-verifier")).toBe("test-quality-v…");
	});

	test("non-verifier role names are unchanged", () => {
		expect(agentTabRoleName("worker")).toBe("worker");
		expect(agentTabRoleName("triage")).toBe("triage");
		expect(agentTabRoleName("planner")).toBe("planner");
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

	test("reduces each tab to the latest run per role", () => {
		const byTab = latestStatusesByTab([
			{ role: "worker", status: "failed", tabId: "t1" },
			{ role: "worker", status: "blocked", tabId: "t1" },
			{ role: "worker", status: "completed", tabId: "t1" },
			{ role: "quality-verifier", status: "working", tabId: "t1" },
			{ role: "worker", status: "completed", tabId: "t2" },
			{ role: "worker", status: "working", tabId: "t2" },
		]);
		expect([...byTab.keys()]).toEqual(["t1", "t2"]);
		// Superseded failed/blocked runs are dropped; the other role is kept.
		expect(byTab.get("t1")).toEqual(["completed", "working"]);
		// The later working run supersedes the earlier completed one.
		expect(byTab.get("t2")).toEqual(["working"]);
	});

	test("ignores every run without a tab id", () => {
		const byTab = latestStatusesByTab([
			{ role: "worker", status: "working" },
			{ role: "quality-verifier", status: "failed" },
		]);
		expect(byTab.size).toBe(0);
	});
});
