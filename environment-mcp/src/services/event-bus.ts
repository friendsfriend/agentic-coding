export type EnvironmentEventType = "status" | "git" | "operation" | "services";

export type EnvironmentEventInput = {
	type: EnvironmentEventType;
	repository?: string;
	operationId?: string;
};

export type EnvironmentEvent = EnvironmentEventInput & {
	seq: number;
	at: number;
};

export type EnvironmentSnapshotEvent = {
	seq: number;
	at: number;
	type: "snapshot";
};

export type EnvironmentStreamEvent =
	| EnvironmentEvent
	| EnvironmentSnapshotEvent;

type Subscriber = {
	repositories: readonly string[];
	send(event: EnvironmentStreamEvent): void;
};

/** Bounded in-process invalidation bus. Events carry no state, only which
 * snapshot the UI should re-read. Subscribers only see their repositories. */
export function createEnvironmentEventBus(
	ringLimit = 256,
	maxSubscribers = 64,
) {
	let seq = 0;
	const ring: EnvironmentEvent[] = [];
	const subscribers = new Set<Subscriber>();
	const visible = (event: EnvironmentEvent, repositories: readonly string[]) =>
		!event.repository || repositories.includes(event.repository);
	return {
		publish(input: EnvironmentEventInput): EnvironmentEvent {
			seq += 1;
			const event: EnvironmentEvent = {
				...input,
				seq,
				at: Date.now(),
			};
			ring.push(event);
			if (ring.length > ringLimit) ring.shift();
			for (const subscriber of subscribers)
				if (visible(event, subscriber.repositories)) subscriber.send(event);
			return event;
		},
		subscribe(
			repositories: readonly string[],
			send: (event: EnvironmentStreamEvent) => void,
		) {
			if (subscribers.size >= maxSubscribers) return undefined;
			const subscriber: Subscriber = {
				repositories: [...repositories],
				send,
			};
			subscribers.add(subscriber);
			return () => {
				subscribers.delete(subscriber);
			};
		},
		replayAfter(lastSeq: number, repositories: readonly string[]) {
			return ring.filter(
				(event) => event.seq > lastSeq && visible(event, repositories),
			);
		},
		currentSeq() {
			return seq;
		},
		subscriberCount() {
			return subscribers.size;
		},
	};
}

export type EnvironmentEventBus = ReturnType<typeof createEnvironmentEventBus>;
