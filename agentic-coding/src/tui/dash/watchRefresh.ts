// Dashboard refresh triggers. Push stays primary: file/event watchers
// (telemetry.jsonl / state.json) debounce bursts into a single refresh call.
// A low-frequency safety resync re-reads authoritative state on a timer so a
// dropped or missed backend event cannot leave the view stale forever.
import { type FSWatcher, watch } from "node:fs";

export interface DebouncedTrigger {
	trigger(): void;
	cancel(): void;
}

/** Cadence for the dashboard's safety resync. A dropped backend event is
 * recovered by the next tick; push events still refresh immediately. */
export const SAFETY_RESYNC_MS = 5_000;

/** Floor between dashboard reads. Push events arrive far faster than a read
 * completes (a streaming agent produced 13-32 reads per 5 s window, back to
 * back), and every read costs a state read plus Git work. Bursts collapse into
 * one trailing read; nothing is dropped, just spaced out. */
export const REFRESH_MIN_INTERVAL_MS = 1_000;

/** Start a periodic safety resync and return a disposer. Pure timer wiring —
 * no I/O — so it is unit-testable with a short interval. */
export function startPeriodicResync(
	onResync: () => void,
	intervalMs = SAFETY_RESYNC_MS,
): () => void {
	const timer = setInterval(onResync, intervalMs);
	return () => clearInterval(timer);
}

/** The dashboard's safety resync: a periodic *forced* refresh. Push events stay
 * primary; this only exists so a dropped update cannot leave the view stale.
 * `refresh(force)` bypasses the cache when force is true. */
export function startSafetyResync(
	refresh: (force: boolean) => void,
	intervalMs = SAFETY_RESYNC_MS,
): () => void {
	return startPeriodicResync(() => refresh(true), intervalMs);
}

/** Collapse rapid successive calls into one `fn()` invocation after `delayMs`
 * of quiet. Pure timer logic — no I/O — so it is unit-testable with fake timers. */
export function debounce(fn: () => void, delayMs: number): DebouncedTrigger {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		trigger() {
			if (timer) clearTimeout(timer);
			timer = setTimeout(fn, delayMs);
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

/** Run `fn` at most once per `intervalMs`, collapsing a burst into a single
 * trailing run instead of a run per arrival. The trailing run keeps the force
 * flag of any trigger that arrived while it was scheduled, so a forced safety
 * resync is never downgraded to a cached read. Pure timer logic — no I/O. */
export interface ThrottledTrigger {
	trigger(force?: boolean): void;
	cancel(): void;
}

export function throttle(
	fn: (force: boolean) => void,
	intervalMs: number,
): ThrottledTrigger {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastRunAt = 0;
	let queuedForce = false;
	return {
		trigger(force = false) {
			queuedForce = queuedForce || force;
			if (timer) return;
			const wait = lastRunAt + intervalMs - Date.now();
			if (wait <= 0) {
				lastRunAt = Date.now();
				queuedForce = false;
				fn(force);
				return;
			}
			timer = setTimeout(() => {
				timer = undefined;
				const pending = queuedForce;
				queuedForce = false;
				lastRunAt = Date.now();
				fn(pending);
			}, wait);
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = undefined;
			queuedForce = false;
		},
	};
}

/** Watch directories (best-effort; a directory that does not exist yet is
 * skipped — the low-frequency safety re-sync picks it up later) and call
 * `onChange` (debounced) whenever a file inside one changes. Returns a disposer. */
export function watchDirectories(
	dirs: Iterable<string>,
	onChange: () => void,
	delayMs = 200,
): () => void {
	const debounced = debounce(onChange, delayMs);
	const watchers: FSWatcher[] = [];
	for (const dir of new Set(dirs)) {
		try {
			watchers.push(watch(dir, () => debounced.trigger()));
		} catch {
			/* directory not created yet */
		}
	}
	return () => {
		debounced.cancel();
		for (const watcher of watchers) watcher.close();
	};
}
