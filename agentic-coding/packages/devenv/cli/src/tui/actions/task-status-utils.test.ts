import { describe, expect, test } from "bun:test";
import { formatDuration, formatTaskArgsSummary } from "./task-status-utils";

describe("formatTaskArgsSummary", () => {
	test("returns empty string for empty args", () => {
		expect(formatTaskArgsSummary({})).toBe("");
	});

	test("formats single arg", () => {
		expect(formatTaskArgsSummary({ env: "prod" })).toBe("--env prod");
	});

	test("formats multiple args", () => {
		const result = formatTaskArgsSummary({ env: "prod", verbose: "" });
		expect(result).toContain("--env prod");
		expect(result).toContain("--verbose");
	});

	test("truncates long values at 30 chars", () => {
		const longVal = "a".repeat(50);
		const result = formatTaskArgsSummary({ config: longVal });
		expect(result).toContain("...");
		expect(result.length).toBeLessThan(longVal.length + 20);
	});

	test("preserves short values without truncation", () => {
		const result = formatTaskArgsSummary({ name: "test" });
		expect(result).toBe("--name test");
		expect(result).not.toContain("...");
	});

	test("handles flags that already start with -", () => {
		const result = formatTaskArgsSummary({ "-v": "" });
		expect(result).toBe("-v ");
	});
});

describe("formatDuration", () => {
	test("formats milliseconds under 1 second", () => {
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(250)).toBe("250ms");
		expect(formatDuration(999)).toBe("999ms");
	});

	test("formats seconds with one decimal", () => {
		expect(formatDuration(1000)).toBe("1.0s");
		expect(formatDuration(3700)).toBe("3.7s");
		expect(formatDuration(59999)).toBe("60.0s");
	});

	test("formats minutes", () => {
		expect(formatDuration(60_000)).toBe("1m");
		expect(formatDuration(120_000)).toBe("2m");
	});

	test("rounds milliseconds correctly", () => {
		expect(formatDuration(1555)).toBe("1.6s");
		expect(formatDuration(1444)).toBe("1.4s");
	});
});
