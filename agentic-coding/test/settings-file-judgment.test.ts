import { describe, expect, test } from "bun:test";
import { fileJudgmentSummaryLabel } from "../src/tui/settings/items.ts";

describe("file judgment inventory label", () => {
	test("an absent table reads as disabled", () => {
		expect(fileJudgmentSummaryLabel(undefined)).toBe("disabled (default)");
	});

	test("an explicitly disabled sweep reads as disabled", () => {
		expect(fileJudgmentSummaryLabel({ enabled: false })).toBe(
			"disabled (default)",
		);
	});

	test("an enabled sweep with unset bounds names them as defaults, never as numbers", () => {
		// The numbers live in the classifier protocol, not in the settings layer:
		// repeating them here is how a view starts disagreeing with the engine.
		expect(fileJudgmentSummaryLabel({ enabled: true })).toBe(
			"enabled · default flag threshold · default unsure floor",
		);
	});

	test("configured bounds are reported verbatim", () => {
		expect(
			fileJudgmentSummaryLabel({
				enabled: true,
				threshold: 0.75,
				unsure: 0.3,
				concurrency: 2,
			}),
		).toBe("enabled · flag > 0.75 · unsure >= 0.3 · concurrency 2");
	});

	test("a partially configured sweep names only what it sets", () => {
		expect(fileJudgmentSummaryLabel({ enabled: true, threshold: 0.9 })).toBe(
			"enabled · flag > 0.9 · default unsure floor",
		);
		expect(fileJudgmentSummaryLabel({ enabled: true, concurrency: 1 })).toBe(
			"enabled · default flag threshold · default unsure floor · concurrency 1",
		);
	});
});
