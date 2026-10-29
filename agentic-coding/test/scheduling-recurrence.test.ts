import { describe, expect, test } from "bun:test";
import {
	decodeScheduling,
	type Timing,
	timingSchema,
} from "../src/contracts/scheduling.ts";
import {
	instant,
	missedRange,
	nextSlot,
	previewTiming,
	resolveDelay,
	resolveLocalOnce,
	validateTiming,
} from "../src/scheduling/recurrence.ts";

const ms = (value: string) => Date.parse(value);
const calendar = (
	timezone = "Europe/Berlin",
	hour = 2,
	minute = 30,
): Extract<Timing, { kind: "calendar" }> => ({
	kind: "calendar",
	weekdays: [1, 2, 3, 4, 5, 6, 7],
	hour,
	minute,
	timezone,
});
describe("structured scheduling recurrence", () => {
	test("relative once resolves now once and exact boundary is inclusive", () => {
		const now = ms("2026-01-01T10:00:00Z"),
			timing = resolveDelay(3600000, "UTC", now);
		expect(nextSlot(timing, now)).toBe(now + 3600000);
		expect(nextSlot(timing, now + 3600000)).toBe(now + 3600000);
		expect(nextSlot(timing, now + 3600001)).toBeNull();
		expect(previewTiming(timing, now).next).toHaveLength(1);
	});
	test("elapsed interval remains anchored across DST and backward clocks", () => {
		const timing: Timing = {
			kind: "interval",
			anchor: "2026-03-28T23:00:00Z",
			everyMs: 6 * 3600000,
			timezone: "Europe/Berlin",
		};
		const values = previewTiming(timing, instant(timing.anchor)).next.map(
			(item) => ms(item.at),
		);
		expect(values).toHaveLength(5);
		for (let i = 1; i < values.length; i++)
			expect((values[i] ?? 0) - (values[i - 1] ?? 0)).toBe(6 * 3600000);
		expect(nextSlot(timing, ms("2026-03-28T00:00:00Z"))).toBe(
			instant(timing.anchor),
		);
	});
	test("spring gap is skipped and autumn fold chooses earlier only", () => {
		expect(
			previewTiming(calendar(), ms("2026-03-28T02:00:00Z")).next[0]?.at,
		).toBe("2026-03-30T00:30:00Z");
		const fold = previewTiming(calendar(), ms("2026-10-25T00:00:00Z")).next;
		expect(fold[0]?.at).toBe("2026-10-25T00:30:00Z");
		expect(fold[1]?.at).toBe("2026-10-26T01:30:00Z");
		expect(nextSlot(calendar(), ms("2026-10-25T00:30:00Z") + 1)).toBe(
			ms("2026-10-26T01:30:00Z"),
		);
	});
	test("non-hour Lord Howe transitions preserve local time", () => {
		const fold = previewTiming(
			calendar("Australia/Lord_Howe", 1, 45),
			ms("2026-04-04T00:00:00Z"),
		).next;
		expect(fold[0]?.at).toBe("2026-04-04T14:45:00Z");
		expect(fold[1]?.at).toBe("2026-04-05T15:15:00Z");
		expect(
			previewTiming(
				calendar("Australia/Lord_Howe", 2, 15),
				ms("2026-10-03T00:00:00Z"),
			).next[0]?.at,
		).toBe("2026-10-04T15:15:00Z");
	});
	test("weekdays and Mondays, leap day and year boundary", () => {
		const weekdays: Timing = {
			...calendar("UTC", 8, 30),
			weekdays: [1, 2, 3, 4, 5],
		};
		expect(
			previewTiming(weekdays, ms("2026-01-02T09:00:00Z")).next[0]?.at,
		).toBe("2026-01-05T08:30:00Z");
		expect(
			nextSlot(
				{ ...weekdays, weekdays: [1], hour: 9 },
				ms("2026-12-31T23:59:00Z"),
			),
		).toBe(ms("2027-01-04T09:30:00Z"));
		expect(
			previewTiming(calendar("UTC"), ms("2028-02-28T03:00:00Z")).next[0]?.at,
		).toBe("2028-02-29T02:30:00Z");
	});
	test("local once requires fold selection and rejects gaps", () => {
		expect(() =>
			resolveLocalOnce("2026-03-29T02:30", "Europe/Berlin"),
		).toThrow();
		expect(() =>
			resolveLocalOnce("2026-10-25T02:30", "Europe/Berlin"),
		).toThrow();
		const early = resolveLocalOnce(
				"2026-10-25T02:30",
				"Europe/Berlin",
				"earlier",
			),
			late = resolveLocalOnce("2026-10-25T02:30", "Europe/Berlin", "later");
		expect(nextSlot(late, 0)).toBe((nextSlot(early, 0) ?? 0) + 3600000);
	});
	test("strict decoding, invalid zones and bounds fail without timezone guessing", () => {
		expect(() =>
			decodeScheduling(timingSchema, { ...calendar(), typo: true }),
		).toThrow();
		for (const zone of ["", "not/a-zone", "+02:00"])
			expect(() => validateTiming(calendar(zone))).toThrow();
		expect(() => validateTiming({ ...calendar(), weekdays: [1, 1] })).toThrow();
		expect(() => validateTiming({ ...calendar(), hour: 24 })).toThrow();
		expect(() =>
			validateTiming({
				kind: "interval",
				anchor: "2026-01-01",
				everyMs: 1,
				timezone: "UTC",
			}),
		).toThrow();
		expect(() => resolveDelay(-1, "UTC", 0)).toThrow();
	});
	test("downtime interval summaries are arithmetic and calendar chunks bounded", () => {
		const timing: Timing = {
			kind: "interval",
			anchor: "2026-01-01T00:00:00Z",
			everyMs: 60000,
			timezone: "UTC",
		};
		const start = instant(timing.anchor),
			end = start + 1_000_000 * 60000;
		expect(missedRange(timing, start, end)).toEqual({
			count: 1_000_000,
			last: end - 60000,
			next: end,
		});
		expect(
			missedRange(
				calendar("UTC"),
				ms("2026-01-01T02:30:00Z"),
				ms("2030-01-01T00:00:00Z"),
			).count,
		).toBe(100);
	});
});
