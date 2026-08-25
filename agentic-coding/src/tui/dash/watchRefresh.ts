// Event-driven refresh trigger for the dashboard's file-backed workflow state
// (telemetry.jsonl / state.json) — replaces the fixed 5s
// re-spawn poll. Debounces bursts of file events into a single refresh call.
import { type FSWatcher, watch } from "node:fs";

export interface DebouncedTrigger {
	trigger(): void;
	cancel(): void;
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
