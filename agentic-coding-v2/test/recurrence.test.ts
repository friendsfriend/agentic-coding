import { expect, test } from "bun:test";
import { nextDue } from "../src/recurrence.ts";
import type { Timing } from "../src/state.ts";

const ms = (date: string) => new Date(date).getTime();
test("calendar weekdays preserve local wall time across spring DST", () => {
	const timing: Timing = {
		kind: "calendar",
		weekdays: [1, 2, 3, 4, 5],
		hour: 9,
		minute: 0,
		timezone: "Europe/Berlin",
	};
	expect(nextDue(timing, ms("2026-03-27T09:00:00+01:00"))).toBe(
		ms("2026-03-30T09:00:00+02:00"),
	);
});
test("spring gap advances and fall fold executes only the earlier wall-time occurrence", () => {
	const timing: Timing = {
		kind: "calendar",
		weekdays: [7],
		hour: 2,
		minute: 30,
		timezone: "Europe/Berlin",
	};
	expect(nextDue(timing, ms("2026-03-29T00:00:00Z"))).toBe(
		ms("2026-03-29T01:30:00Z"),
	);
	const first = nextDue(timing, ms("2026-10-25T00:00:00Z"));
	expect(first).toBe(ms("2026-10-25T00:30:00Z"));
	expect(nextDue(timing, Number(first))).toBe(ms("2026-11-01T01:30:00Z"));
});
