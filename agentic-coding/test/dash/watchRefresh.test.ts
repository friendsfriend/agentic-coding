import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterNextFrame,
	debounce,
	SAFETY_RESYNC_MS,
	seedThenHydrate,
	startPeriodicResync,
	startSafetyResync,
	throttle,
	watchDirectories,
} from "../../src/tui/dash/watchRefresh.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/** Poll until `condition` holds or the deadline passes, so fs.watch delivery
 * is not asserted against a fixed sleep that parallel test load can outrun.
 * `tick` re-triggers the watched write, since the watcher may only become
 * active after the first write on a loaded machine. The poll interval must
 * exceed the watcher's debounce window (20ms) or each tick resets the debounce
 * before it can fire. */
async function waitUntil(
	condition: () => boolean,
	timeoutMs = 2_000,
	tick?: () => void,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !condition()) {
		tick?.();
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}

test("debounce collapses rapid triggers into one call", async () => {
	let calls = 0;
	const debounced = debounce(() => calls++, 20);

	debounced.trigger();
	debounced.trigger();
	debounced.trigger();
	await new Promise((resolve) => setTimeout(resolve, 60));

	expect(calls).toBe(1);
	debounced.cancel();
});

test("debounce cancel suppresses a pending call", async () => {
	let calls = 0;
	const debounced = debounce(() => calls++, 20);

	debounced.trigger();
	debounced.cancel();
	await new Promise((resolve) => setTimeout(resolve, 60));

	expect(calls).toBe(0);
});

test("throttle runs the first trigger at once and collapses a burst into one trailing run", async () => {
	const runs: boolean[] = [];
	const throttled = throttle((force) => runs.push(force), 40);

	throttled.trigger();
	// Arrivals during the interval must not each start a read: a streaming agent
	// produced 13-32 reads per 5 s window this way.
	for (let i = 0; i < 5; i += 1) throttled.trigger();
	await new Promise((resolve) => setTimeout(resolve, 90));

	expect(runs).toEqual([false, false]);
	throttled.cancel();
});

test("throttle keeps a forced trigger's flag on the trailing run", async () => {
	const runs: boolean[] = [];
	const throttled = throttle((force) => runs.push(force), 40);

	throttled.trigger();
	throttled.trigger(true); // a safety resync must still bypass the cache
	await new Promise((resolve) => setTimeout(resolve, 90));

	expect(runs).toEqual([false, true]);
	throttled.cancel();
});

test("throttle cancel suppresses the trailing run", async () => {
	const runs: boolean[] = [];
	const throttled = throttle((force) => runs.push(force), 40);

	throttled.trigger();
	throttled.trigger();
	throttled.cancel();
	await new Promise((resolve) => setTimeout(resolve, 90));

	expect(runs).toEqual([false]);
});

test("startPeriodicResync fires on the interval and stops on dispose", async () => {
	let calls = 0;
	const dispose = startPeriodicResync(() => calls++, 10);
	await waitUntil(() => calls >= 2, 1_000);
	expect(calls).toBeGreaterThanOrEqual(2);
	dispose();
	const afterDispose = calls;
	await new Promise((resolve) => setTimeout(resolve, 40));
	expect(calls).toBe(afterDispose);
});

test("startSafetyResync forces a refresh on every tick at the 5s default", async () => {
	// Pin the production cadence: a 0 or huge default would otherwise pass the
	// interval test, which passes its own short interval.
	expect(SAFETY_RESYNC_MS).toBe(5_000);
	const forces: boolean[] = [];
	const dispose = startSafetyResync((force) => forces.push(force), 10);
	await waitUntil(() => forces.length >= 2, 1_000);
	expect(forces.length).toBeGreaterThanOrEqual(2);
	expect(forces.every((force) => force)).toBe(true);
	dispose();
});

test("watchDirectories fires onChange when a watched file changes, and skips missing dirs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-dash-watch-"));
	roots.push(dir);
	let calls = 0;
	const dispose = watchDirectories(
		[dir, join(dir, "does-not-exist")],
		() => calls++,
		20,
	);

	const target = join(dir, "telemetry.jsonl");
	writeFileSync(target, '{"event":"start"}\n');
	await waitUntil(
		() => calls >= 1,
		2_000,
		() => writeFileSync(target, `{"event":"tick"}\n`),
	);

	expect(calls).toBeGreaterThanOrEqual(1);
	dispose();
});

/** A frame source the test fires by hand, standing in for OpenTUI's renderer. */
function fakeFrames() {
	const listeners = new Set<() => void>();
	return {
		source: {
			on(_event: string, listener: () => void) {
				listeners.add(listener);
			},
			off(_event: string, listener: () => void) {
				listeners.delete(listener);
			},
		},
		get waiting() {
			return listeners.size;
		},
		emit() {
			for (const listener of [...listeners]) listener();
		},
	};
}

test("seedThenHydrate hydrates only after the seed's paint has been rendered", async () => {
	const frames = fakeFrames();
	const order: string[] = [];
	const seed = (async () => {
		order.push("seed");
		return undefined;
	})();
	const done = seedThenHydrate(seed, frames.source, () =>
		order.push("hydrate"),
	);
	// The seed settling is not enough: the renderer still owes one frame, and the
	// hydrate must not take the loop before it.
	await Bun.sleep(5);
	expect(order).toEqual(["seed"]);
	expect(frames.waiting).toBe(1);
	frames.emit();
	await done;
	expect(order).toEqual(["seed", "hydrate"]);
	expect(frames.waiting).toBe(0);
});

test("seedThenHydrate still hydrates when the seed read failed", async () => {
	// The full observation owns the visible diagnostics: a seed that failed must
	// not leave the dashboard on its placeholder forever.
	const frames = fakeFrames();
	let hydrated = 0;
	const done = seedThenHydrate(
		Promise.reject(new Error("view read failed")),
		frames.source,
		() => hydrated++,
	);
	frames.emit();
	await done;
	expect(hydrated).toBe(1);
});

test("seedThenHydrate hydrates nothing once the view is disposed", async () => {
	const frames = fakeFrames();
	let hydrated = 0;
	// Already disposed: the seed has landed but the view is gone, so the helper
	// does not even wait for a frame.
	await seedThenHydrate(
		Promise.resolve(undefined),
		frames.source,
		() => hydrated++,
		() => true,
	);
	expect(hydrated).toBe(0);
	expect(frames.waiting).toBe(0);

	// Disposed while waiting for the frame: the pending paint hydrates nothing.
	let checks = 0;
	const waiting = seedThenHydrate(
		Promise.resolve(undefined),
		frames.source,
		() => hydrated++,
		() => ++checks > 1,
	);
	await Bun.sleep(5);
	frames.emit();
	await waiting;
	expect(hydrated).toBe(0);
	expect(frames.waiting).toBe(0);
});

test("afterNextFrame resolves on a frame that never arrives, bounded by its timeout", async () => {
	const frames = fakeFrames();
	const started = Date.now();
	await afterNextFrame(frames.source, "frame", 20);
	expect(Date.now() - started).toBeGreaterThanOrEqual(15);
	// The waiter unsubscribed on the way out, so a later frame is not delivered
	// to a promise that already settled.
	expect(frames.waiting).toBe(0);
});
