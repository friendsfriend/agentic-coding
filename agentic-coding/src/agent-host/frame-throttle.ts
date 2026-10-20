// Coalesced delivery of agent conversation state frames.
//
// The host forwards its conversation state to every watcher on each subscriber
// change, and a generating model changes it at token rate. Every frame crosses
// the control socket and rebuilds the watcher's transcript (a snapshot walk plus
// a markdown parse of the growing message), so an uncoalesced stream keeps the
// client busy at token rate — exactly when the developer is typing into the
// same terminal. This delivers at most one frame per window, always the newest
// one, so the stream stays live and the work per frame is bounded.

export interface FrameThrottle<T> {
	/** Offer the newest value. */
	push(value: T): void;
	/** Deliver anything queued now (used when the caller stops waiting). */
	flush(): void;
	/** Drop anything queued and stop delivering: a stopped watcher must not be
	 * handed a frame after its socket closed. */
	dispose(): void;
}

export interface FrameThrottleOptions<T> {
	/** Shortest interval between two deliveries. */
	readonly windowMs: number;
	readonly deliver: (value: T) => void;
	/** Injectable clock and timer, so the window is testable without sleeping. */
	readonly now?: () => number;
	readonly setTimer?: (run: () => void, ms: number) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
}

/** The same throttle for an ordered batch: every offered item is kept (unlike a
 * newest-only frame) and delivered as one batch at the window boundary. Patch
 * frames cannot drop intermediate operations, because each one builds on the
 * previous value. */
export interface BatchThrottle<T> {
	/** Append items to the next delivery. An empty batch is ignored. */
	push(items: readonly T[]): void;
	/** Request a delivery even when no items were appended, for a side-channel
	 * update (the measured timings) that travels in the same patch. */
	wake(): void;
	flush(): void;
	dispose(): void;
}

/** Leading-and-trailing batch throttle: a quiet stream delivers immediately; a
 * burst is concatenated and delivered once at the window's end. */
export function createBatchThrottle<T>(
	options: FrameThrottleOptions<readonly T[]>,
): BatchThrottle<T> {
	const window = Math.max(0, options.windowMs);
	const now = options.now ?? (() => Date.now());
	const setTimer =
		options.setTimer ??
		((run, ms) => setTimeout(run, ms) satisfies ReturnType<typeof setTimeout>);
	const clearTimer =
		options.clearTimer ??
		((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	let deliveredAt = Number.NEGATIVE_INFINITY;
	let queued: T[] = [];
	let pending = false;
	let timer: unknown;

	const deliverQueued = (): void => {
		timer = undefined;
		if (!pending) return;
		const batch = queued;
		queued = [];
		pending = false;
		deliveredAt = now();
		options.deliver(batch);
	};
	const cancelTimer = (): void => {
		if (timer === undefined) return;
		clearTimer(timer);
		timer = undefined;
	};
	const schedule = (): void => {
		const at = now();
		if (at - deliveredAt >= window) {
			cancelTimer();
			deliverQueued();
			return;
		}
		timer ??= setTimer(deliverQueued, Math.max(0, window - (at - deliveredAt)));
	};

	return {
		push(items) {
			if (items.length === 0) return;
			queued.push(...items);
			pending = true;
			schedule();
		},
		wake() {
			pending = true;
			schedule();
		},
		flush() {
			cancelTimer();
			deliverQueued();
		},
		dispose() {
			cancelTimer();
			queued = [];
			pending = false;
		},
	};
}

/** A leading-and-trailing throttle: a value arrives immediately when the window
 * is quiet, and a burst is collapsed to its newest value at the window's end
 * (so the last state of a burst is never lost and never delayed past it). */
export function createFrameThrottle<T>(
	options: FrameThrottleOptions<T>,
): FrameThrottle<T> {
	const window = Math.max(0, options.windowMs);
	const now = options.now ?? (() => Date.now());
	const setTimer =
		options.setTimer ??
		((run, ms) => setTimeout(run, ms) satisfies ReturnType<typeof setTimeout>);
	const clearTimer =
		options.clearTimer ??
		((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	let deliveredAt = now();
	let queued: { readonly value: T } | undefined;
	let timer: unknown;

	const deliverQueued = (): void => {
		timer = undefined;
		const next = queued;
		queued = undefined;
		if (next === undefined) return;
		deliveredAt = now();
		options.deliver(next.value);
	};
	const cancelTimer = (): void => {
		if (timer === undefined) return;
		clearTimer(timer);
		timer = undefined;
	};

	return {
		push(value) {
			const at = now();
			if (at - deliveredAt >= window) {
				// Quiet for a whole window: deliver now instead of making a live stream
				// wait out a timer.
				queued = undefined;
				deliveredAt = at;
				options.deliver(value);
				return;
			}
			queued = { value };
			timer ??= setTimer(
				deliverQueued,
				Math.max(0, window - (at - deliveredAt)),
			);
		},
		flush() {
			cancelTimer();
			deliverQueued();
		},
		dispose() {
			cancelTimer();
			queued = undefined;
		},
	};
}
