// Applying the host's incremental watch patches. The transcript is advanced by
// chord operations against the snapshot the client already holds, so the two
// properties that matter are: only touched containers are copied, and the
// measured timings (which are not part of the view's delta) survive a root
// replacement.
import { expect, test } from "bun:test";
import { applyWatchPatch } from "../src/agent-host/view-ops.ts";

test("a patch advances the view immutably and keeps untouched branches", () => {
	const previous = {
		entries: [
			{ id: "a", text: "hel" },
			{ id: "b", text: "second" },
		],
		docs: { "pi.live": { run: "working" } },
		timings: { a: { durationMs: 12 } },
	};
	const next = applyWatchPatch(previous, {
		ops: [["s", ["entries", 0, "text"], "hello"]],
	}) as typeof previous;
	expect(next.entries[0]?.text).toBe("hello");
	expect(next.entries[1]).toBe(previous.entries[1] ?? undefined);
	expect(next.docs).toBe(previous.docs);
	expect(next.timings).toEqual({ a: { durationMs: 12 } });
	expect(previous.entries[0]?.text).toBe("hel");
});

test("a root replacement carries the measured timings across", () => {
	const previous = {
		entries: [{ id: "a" }],
		timings: { a: { durationMs: 12 } },
	};
	const replacement = { entries: [{ id: "a" }, { id: "b" }] };
	const next = applyWatchPatch(previous, {
		ops: [["r", replacement]],
	}) as { entries: unknown[]; timings: unknown };
	expect(next.entries).toHaveLength(2);
	expect(next.timings).toEqual({ a: { durationMs: 12 } });
});

test("a patch can update the timings without a view operation", () => {
	const previous = { entries: [], timings: { a: { durationMs: 1 } } };
	const next = applyWatchPatch(previous, {
		ops: [],
		timings: { a: { durationMs: 42 } },
	}) as { timings: unknown };
	expect(next.timings).toEqual({ a: { durationMs: 42 } });
});

test("an unsafe path is refused instead of being applied", () => {
	expect(() =>
		applyWatchPatch(
			{ entries: [] },
			{ ops: [["s", ["__proto__", "polluted"], true]] },
		),
	).toThrow();
});
