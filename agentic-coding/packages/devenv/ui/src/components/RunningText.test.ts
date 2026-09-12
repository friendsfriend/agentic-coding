import { describe, expect, test } from "bun:test";
import { runningTextFrame } from "./RunningText";

describe("runningTextFrame", () => {
	test("keeps left alignment behavior by default", () => {
		expect(runningTextFrame("abc", 6, false, false, 0)).toBe("abc ");
	});

	test("right-aligns short text inside full width", () => {
		expect(runningTextFrame("abc", 6, false, false, 0, 13, 13, "right")).toBe(
			"   abc",
		);
	});

	test("right-aligned overflow uses full bounding width", () => {
		expect(
			runningTextFrame("abcdefghi", 6, false, false, 0, 13, 13, "right"),
		).toBe("abcde…");
	});
});
