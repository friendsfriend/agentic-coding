/** Coalesce mutable progress before snapshotting it. One write may be in
 * flight and one dirty flag may be pending; never queue historical full logs. */
export function createProgressPublisher<T>(
	snapshot: () => T,
	write: (value: T) => Promise<void>,
	options: {
		windowMs?: number;
		now?: () => number;
		setTimer?: (run: () => void, ms: number) => unknown;
		clearTimer?: (handle: unknown) => void;
	} = {},
) {
	const now = options.now ?? Date.now;
	const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
	const clearTimer =
		options.clearTimer ??
		((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const windowMs = options.windowMs ?? 50;
	let last = Number.NEGATIVE_INFINITY;
	let dirty = false;
	let disposed = false;
	let failure: unknown;
	let failed = false;
	let writing: Promise<void> | undefined;
	let timer: unknown;
	const cancel = () => {
		if (timer !== undefined) {
			clearTimer(timer);
			timer = undefined;
		}
	};
	const start = () => {
		cancel();
		if (disposed || writing || !dirty || failed) return;
		dirty = false;
		last = now();
		const value = snapshot();
		writing = Promise.resolve().then(() => write(value));
		void writing.then(
			() => {
				writing = undefined;
				schedule();
			},
			(error) => {
				failed = true;
				failure = error;
				writing = undefined;
				dirty = false;
			},
		);
	};
	const schedule = () => {
		if (disposed || writing || !dirty || failed || timer !== undefined) return;
		const remaining = windowMs - (now() - last);
		if (remaining <= 0) start();
		else
			timer = setTimer(() => {
				timer = undefined;
				start();
			}, remaining);
	};
	return {
		request() {
			if (!disposed) {
				dirty = true;
				schedule();
			}
		},
		async flush() {
			cancel();
			while (!disposed && (dirty || writing)) {
				if (failed) throw failure;
				if (writing) await writing;
				else start();
			}
			if (failed) throw failure;
		},
		dispose() {
			disposed = true;
			dirty = false;
			cancel();
		},
	};
}

export const LIVE_TOOL_OUTPUT_CHARS = 50_000;
export function boundedLiveOutput(
	previous: string,
	chunk: string,
): { text: string; truncated: boolean } {
	const combined = previous + chunk;
	if (combined.length <= LIVE_TOOL_OUTPUT_CHARS)
		return { text: combined, truncated: false };
	const tail = combined.slice(-LIVE_TOOL_OUTPUT_CHARS);
	const first = tail.charCodeAt(0);
	return {
		text: first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail,
		truncated: true,
	};
}
