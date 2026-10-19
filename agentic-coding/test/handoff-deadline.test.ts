// The one human rendering of a hand-off deadline (`add-stage-interactive-login`,
// USAB-101/USAB-103).
//
// The banner in the login window, the dashboard's modal and the attention
// record all render one deadline, and a developer is the one who has to act
// before it. These cases pin the wording so a surface cannot drift into an ISO
// instant or a negative remainder on its own.
import { expect, test } from "bun:test";
import { formatHandoffDeadline } from "../src/contracts/handoff-deadline.ts";

/** A fixed instant, so the local clock in the result is not the host's. */
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

/** The local wall-clock time this instant reads as on the host running the
 * test, which is what the developer would see on their own clock. */
function localClock(at: number): string {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test("a deadline is a local time with its remainder, and never an ISO instant", () => {
	const at = NOW + 14 * 60_000;
	expect(formatHandoffDeadline(at, NOW)).toBe(
		`${localClock(at)} local (in about 14 minutes)`,
	);
	expect(formatHandoffDeadline(new Date(at).toISOString(), NOW)).toBe(
		`${localClock(at)} local (in about 14 minutes)`,
	);
	const rendered = formatHandoffDeadline(at, NOW);
	expect(rendered).not.toContain("T");
	expect(rendered).not.toContain("Z");
});

test("the short remainders are words, never a count of zero minutes", () => {
	expect(formatHandoffDeadline(NOW + 20_000, NOW)).toBe(
		`${localClock(NOW + 20_000)} local (in less than a minute)`,
	);
	expect(formatHandoffDeadline(NOW + 60_000, NOW)).toBe(
		`${localClock(NOW + 60_000)} local (in about a minute)`,
	);
	expect(formatHandoffDeadline(NOW + 89 * 60_000, NOW)).toBe(
		`${localClock(NOW + 89 * 60_000)} local (in about 89 minutes)`,
	);
	// A day-long bound (a question's own expiry) reads in hours.
	expect(formatHandoffDeadline(NOW + 24 * 60 * 60_000, NOW)).toBe(
		`${localClock(NOW + 24 * 60 * 60_000)} local (in about 24 hours)`,
	);
});

test("a deadline already gone says so, and one that cannot be read says that instead", () => {
	expect(formatHandoffDeadline(NOW - 1, NOW)).toBe(
		`${localClock(NOW - 1)} local (already due)`,
	);
	// The deadline itself is still a time: only the remainder is a word.
	expect(formatHandoffDeadline(NOW, NOW)).toBe(
		`${localClock(NOW)} local (already due)`,
	);
	for (const unreadable of [
		"not a date",
		"",
		Number.NaN,
		Number.POSITIVE_INFINITY,
	]) {
		expect(formatHandoffDeadline(unreadable, NOW)).toBe("an unknown time");
	}
});
