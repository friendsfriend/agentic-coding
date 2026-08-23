import { expect, test } from "bun:test";
import { formatDuration } from "../src/workflow/format.ts";

test("clamps non-finite and negative input to 0s", () => {
	expect(formatDuration(Number.NaN)).toBe("0s");
	expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0s");
	expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe("0s");
	expect(formatDuration(-5)).toBe("0s");
	expect(formatDuration(-0.5)).toBe("0s");
});

test("renders sub-minute durations as whole seconds", () => {
	expect(formatDuration(0)).toBe("0s");
	expect(formatDuration(3)).toBe("3s");
	expect(formatDuration(59)).toBe("59s");
});

test("renders exact-minute durations as minutes only", () => {
	expect(formatDuration(60)).toBe("1m");
	expect(formatDuration(120)).toBe("2m");
	expect(formatDuration(3540)).toBe("59m");
});

test("renders minute durations with leftover whole seconds", () => {
	expect(formatDuration(61)).toBe("1m 1s");
	expect(formatDuration(245)).toBe("4m 5s");
	expect(formatDuration(3599)).toBe("59m 59s");
});

test("renders hour durations as hours with leftover whole minutes", () => {
	expect(formatDuration(3600)).toBe("1h");
	expect(formatDuration(3660)).toBe("1h 1m");
	expect(formatDuration(3900)).toBe("1h 5m");
	expect(formatDuration(7199)).toBe("1h 59m");
});

test("renders long durations past 24 hours", () => {
	expect(formatDuration(86400)).toBe("24h");
	expect(formatDuration(90120)).toBe("25h 2m");
	expect(formatDuration(100000)).toBe("27h 46m");
});

test("truncates fractional input toward zero", () => {
	expect(formatDuration(3.9)).toBe("3s");
	expect(formatDuration(245.7)).toBe("4m 5s");
	expect(formatDuration(3660.9)).toBe("1h 1m");
});
