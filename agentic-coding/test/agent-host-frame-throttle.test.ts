// Frame coalescing for the agent host's conversation stream (host.ts
// `watchRun`): a generating model changes the conversation at token rate, and
// every frame the watcher receives rebuilds its whole transcript. The window is
// driven by a fake clock here, so the two things that matter are pinned without
// sleeping: a burst costs one frame, and the newest value in that burst is the
// one that arrives.
import { expect, test } from "bun:test";
import { createFrameThrottle } from "../src/agent-host/frame-throttle.ts";

/** A clock and timer the test drives by hand. */
function fakeClock() {
	let at = 0;
	const timers = new Map<number, { run: () => void; at: number }>();
	let nextId = 1;
	return {
		now: () => at,
		setTimer: (run: () => void, ms: number) => {
			const id = nextId++;
			timers.set(id, { run, at: at + ms });
			return id;
		},
		clearTimer: (handle: unknown) => {
			timers.delete(handle as number);
		},
		/** Move to the next scheduled timer and run it. */
		fireNext: () => {
			const next = [...timers.entries()].sort(
				([, left], [, right]) => left.at - right.at,
			)[0];
			if (!next) return false;
			timers.delete(next[0]);
			at = next[1].at;
			next[1].run();
			return true;
		},
		advance: (ms: number) => {
			at += ms;
		},
		pending: () => timers.size,
	};
}

test("a burst costs one frame, and the newest value is the one delivered", () => {
	const clock = fakeClock();
	const delivered: number[] = [];
	const frames = createFrameThrottle<number>({
		windowMs: 50,
		deliver: (value) => delivered.push(value),
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	// The first value waits out its window, then arrives.
	frames.push(1);
	expect(delivered).toEqual([]);
	expect(clock.fireNext()).toBe(true);
	expect(delivered).toEqual([1]);
	// A token-rate burst inside the window collapses to its newest value.
	for (const value of [2, 3, 4]) frames.push(value);
	expect(delivered).toEqual([1]);
	expect(clock.pending()).toBe(1);
	expect(clock.fireNext()).toBe(true);
	expect(delivered).toEqual([1, 4]);
	// A value after a quiet window is delivered at once instead of waiting.
	clock.advance(50);
	frames.push(5);
	expect(delivered).toEqual([1, 4, 5]);
	expect(clock.pending()).toBe(0);
});

test("flush delivers what is queued and dispose drops it", () => {
	const clock = fakeClock();
	const delivered: string[] = [];
	const frames = createFrameThrottle<string>({
		windowMs: 50,
		deliver: (value) => delivered.push(value),
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	frames.push("a");
	frames.push("b");
	frames.flush();
	expect(delivered).toEqual(["b"]);
	// The timer flush cancelled must not deliver anything a second time.
	expect(clock.fireNext()).toBe(false);
	// A value queued when the watcher stops is dropped, not handed to a closed
	// socket.
	frames.push("c");
	frames.dispose();
	expect(delivered).toEqual(["b"]);
	expect(clock.pending()).toBe(0);
	expect(clock.fireNext()).toBe(false);
});
