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
