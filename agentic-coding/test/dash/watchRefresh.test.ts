import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	debounce,
	SAFETY_RESYNC_MS,
	startPeriodicResync,
	startSafetyResync,
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
