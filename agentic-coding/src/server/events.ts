// Domain event envelope and bounded replay for the unified backend
// (expose-unified-bun-backend, task 3.1/3.2). Events identify the server
// instance, domain, resource/run and revision context; a slow subscriber is
// never allowed to block mutation execution. When a reconnect cursor falls
// outside the retained window the server requires snapshot resynchronization
// instead of silently continuing from a gap.
import { EVENT_REPLAY_CAPACITY } from "./protocol.ts";

export interface EventEnvelope {
	readonly instance: string;
	/** Monotonic per-instance sequence; gaps are detectable. */
	readonly sequence: number;
	readonly domain: string;
	readonly kind: string;
	readonly resource?: string;
	readonly runId?: string;
	readonly revision?: number;
	readonly at: string;
	readonly payload: unknown;
}

export interface PublishInput {
	readonly domain: string;
	readonly kind: string;
	readonly resource?: string;
	readonly runId?: string;
	readonly revision?: number;
	readonly payload?: unknown;
}

export interface SubscriptionCursor {
	/** Last sequence the client already applied; omit for "live only". */
	readonly after?: number;
}

export interface Subscription {
	readonly replay: readonly EventEnvelope[];
	/** True when the cursor predates the retained window: the client MUST
	 * resynchronize from an authoritative snapshot before applying live events. */
	readonly snapshotRequired: boolean;
	/** Drop the subscription; idempotent. */
	unsubscribe(): void;
}

/** Bounded per-subscriber queue. Overflow marks the subscriber as needing a
 * snapshot rather than growing without bound or blocking the publisher. */
export class SubscriberQueue {
	readonly queue: EventEnvelope[] = [];
	needsSnapshot = false;
	closed = false;
	constructor(
		readonly capacity: number,
		readonly onEvent: (event: EventEnvelope) => void,
		readonly onOverflow: () => void,
	) {}

	push(event: EventEnvelope): void {
		if (this.closed) return;
		if (this.queue.length >= this.capacity) {
			this.queue.shift();
			this.needsSnapshot = true;
			this.onOverflow();
			return;
		}
		this.queue.push(event);
		this.onEvent(event);
	}

	drain(): EventEnvelope[] {
		const drained = this.queue.slice();
		this.queue.length = 0;
		return drained;
	}

	close(): void {
		this.closed = true;
		this.queue.length = 0;
	}
}

interface LiveSubscriber {
	readonly queue: SubscriberQueue;
}

export class EventBroker {
	private sequence = 0;
	private readonly ring: EventEnvelope[] = [];
	private readonly subscribers = new Set<LiveSubscriber>();

	constructor(
		readonly instance: string,
		readonly capacity = EVENT_REPLAY_CAPACITY,
		private readonly now: () => Date = () => new Date(),
	) {}

	/** Current sequence (0 before the first publish). */
	get currentSequence(): number {
		return this.sequence;
	}

	publish(input: PublishInput): EventEnvelope {
		this.sequence += 1;
		const event: EventEnvelope = {
			instance: this.instance,
			sequence: this.sequence,
			domain: input.domain,
			kind: input.kind,
			...(input.resource ? { resource: input.resource } : {}),
			...(input.runId ? { runId: input.runId } : {}),
			...(input.revision !== undefined ? { revision: input.revision } : {}),
			at: this.now().toISOString(),
			payload: input.payload ?? null,
		};
		this.ring.push(event);
		if (this.ring.length > this.capacity) this.ring.shift();
		for (const subscriber of this.subscribers) subscriber.queue.push(event);
		return event;
	}

	/** All retained events after `cursor` when it is still inside the window. */
	replay(after?: number): {
		events: EventEnvelope[];
		snapshotRequired: boolean;
	} {
		if (after === undefined) return { events: [], snapshotRequired: false };
		const oldest = this.ring[0]?.sequence ?? this.sequence + 1;
		// A cursor ahead of the server (stale instance) or older than the
		// retained window requires an authoritative snapshot.
		if (after > this.sequence || after < oldest - 1)
			return { events: [], snapshotRequired: true };
		return {
			events: this.ring.filter((event) => event.sequence > after),
			snapshotRequired: false,
		};
	}

	/** Open a live subscription, optionally with an immediate replay. A
	 * subscription whose cursor is outside the window replays nothing and sets
	 * `snapshotRequired`. */
	open(
		cursor: SubscriptionCursor = {},
		onEvent: (event: EventEnvelope) => void = () => {},
		onOverflow: () => void = () => {},
		capacity = this.capacity,
	): Subscription {
		const replay = this.replay(cursor.after);
		const queue = new SubscriberQueue(capacity, onEvent, () => onOverflow());
		const subscriber: LiveSubscriber = { queue };
		this.subscribers.add(subscriber);
		return {
			replay: replay.events,
			snapshotRequired: replay.snapshotRequired,
			unsubscribe: () => {
				queue.close();
				this.subscribers.delete(subscriber);
			},
		};
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	/** Test/shutdown helper: drop every subscription. */
	closeAll(): void {
		for (const subscriber of this.subscribers) subscriber.queue.close();
		this.subscribers.clear();
	}
}
