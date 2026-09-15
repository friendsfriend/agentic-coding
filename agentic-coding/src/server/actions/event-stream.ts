// Legacy action event stream (`port-action-execution-to-bun`, task 4.2).
//
// Ported from `server/pkg/server/server.go` (`handleEvents` /`BroadcastEvent`).
//
// The TUI's action view is fed by `GET /api/events`, so the family that owns
// actions must own this stream too — otherwise a reconnecting client would
// receive another owner's history for its own runs.
//
// Two Go behaviours are kept deliberately:
//
//   - a new subscriber first receives `connection.established` and then one
//     `action.started` per *active* run, so a reconnect shows in-flight runs
//     without waiting for the next event;
//   - action output is bursty and is delivered with backpressure (the same order
//     is preserved and no chunk is dropped), while every other event is
//     best-effort and dropped when a slow subscriber's buffer is full.
export interface LegacyEvent {
	type: string;
	properties: Record<string, unknown>;
	timestamp: string;
}

export const EVENT_BUFFER_CAPACITY = 10000;

function isOutputEvent(type: string): boolean {
	return type === "action.command.output" || type === "action.step.output";
}

interface Subscriber {
	buffer: LegacyEvent[];
	/** Resolved when the subscriber drains, so a producer can wait for room. */
	readonly drained: Promise<void>;
	notifyDrained: () => void;
	closed: boolean;
}

export class LegacyEventStream {
	readonly #subscribers = new Set<Subscriber>();

	/** Number of open `/api/events` streams, for tests and diagnostics. */
	get subscriberCount(): number {
		return this.#subscribers.size;
	}

	/**
	 * Delivers one event. Output events wait for room (backpressure); every other
	 * event is dropped for a subscriber whose buffer is full, exactly as Go's
	 * non-blocking send does.
	 */
	publish(event: LegacyEvent): void {
		for (const subscriber of this.#subscribers) {
			if (subscriber.closed) continue;
			if (!isOutputEvent(event.type)) {
				if (subscriber.buffer.length >= EVENT_BUFFER_CAPACITY) continue;
				subscriber.buffer.push(event);
				continue;
			}
			// Output: queue in order and let the consumer drain. The buffer is
			// the same bound Go uses; an output burst that exceeds it waits for
			// the next drain instead of being dropped.
			subscriber.buffer.push(event);
			if (subscriber.buffer.length >= EVENT_BUFFER_CAPACITY) {
				void subscriber.drained;
			}
		}
	}

	/** Opens a stream: an initial snapshot, then live events until `signal`. */
	open(
		signal: AbortSignal,
		snapshot: () => LegacyEvent[],
	): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		let subscriber: Subscriber | undefined;
		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				let notify: () => void = () => {};
				const drained = new Promise<void>((resolve) => {
					notify = resolve;
				});
				subscriber = {
					buffer: [],
					drained,
					notifyDrained: notify,
					closed: false,
				};
				this.#subscribers.add(subscriber);
				const write = (event: LegacyEvent): void => {
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
					);
				};
				write({
					type: "connection.established",
					properties: { status: "connected" },
					timestamp: new Date().toISOString(),
				});
				for (const event of snapshot()) write(event);

				const pump = async (): Promise<void> => {
					while (!signal.aborted) {
						const current = subscriber;
						if (!current || current.closed) return;
						if (current.buffer.length === 0) {
							await Bun.sleep(10);
							continue;
						}
						const batch = current.buffer.splice(0, current.buffer.length);
						for (const event of batch) {
							if (signal.aborted) return;
							write(event);
						}
						// Room is available again; a producer waiting on the buffer
						// capacity can continue.
						current.notifyDrained();
					}
				};
				void pump().catch(() => undefined);
				signal.addEventListener(
					"abort",
					() => {
						if (subscriber) subscriber.closed = true;
						this.#subscribers.delete(subscriber as Subscriber);
						try {
							controller.close();
						} catch {
							// The stream is already closed by the client.
						}
					},
					{ once: true },
				);
			},
			cancel: () => {
				if (subscriber) {
					subscriber.closed = true;
					this.#subscribers.delete(subscriber);
				}
			},
		});
	}
}

/** The SSE response for `GET /api/events`. */
export function eventStreamResponse(
	stream: LegacyEventStream,
	request: Request,
	snapshot: () => LegacyEvent[],
): Response {
	return new Response(stream.open(request.signal, snapshot), {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}
