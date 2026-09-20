// Dashboard data layer (establish-opencode-boundaries, section 4).
//
// One keyed reactive cache over the `DashboardGateway` port. Feature modules
// read through the selectors here and never reach workflow/server/filesystem
// internals: the gateway decides whether a read travels over the transport or
// runs in-process, and the cache decides what is fresh.
//
// The cache is deliberately small: keys are repository/workflow/resource
// strings, entries carry the revision they were read at, a workflow event
// invalidates the entries it names, and an event gap (unknown or missing
// revision) marks everything stale so the next read is authoritative instead
// of guessed.
import { createSignal } from "solid-js";
import type { EventEnvelope } from "../../contracts/environment.ts";
import type { DashboardGateway } from "../../contracts/gateway.ts";

let configured: DashboardGateway | undefined;

/** Install the gateway for this process (composition root). */
export function configureGateway(gateway: DashboardGateway): DashboardGateway {
	configured = gateway;
	cache.clear();
	return gateway;
}

export function clearGateway(): void {
	configured = undefined;
	cache.clear();
}

/** The active gateway. Throws when the composition root forgot to install one:
 * a data read without a transport decision is a bug, not a fallback. */
export function gateway(): DashboardGateway {
	if (!configured)
		throw new Error("no dashboard gateway configured for this process");
	return configured;
}

export function gatewayOrUndefined(): DashboardGateway | undefined {
	return configured;
}

export interface CacheEntry<T> {
	readonly value: T;
	/** Workflow revision the value was read at, when the read carries one. */
	readonly revision?: number;
	readonly at: number;
}

interface InternalEntry {
	readonly signal: () => CacheEntry<unknown> | undefined;
	readonly set: (entry: CacheEntry<unknown> | undefined) => void;
	generation: number;
}

export interface ReadOptions {
	readonly signal?: AbortSignal;
	/** Workflow revision the caller rendered; a read at a new revision replaces
	 * the cached value, and a late result from an older generation is dropped. */
	readonly revision?: number;
	/** Force a network/in-process read even when a value is cached. */
	readonly refresh?: boolean;
}

/** Keys are namespaced by resource so invalidation can be targeted:
 * `workflow:<repo>:<workflowId>`, `dashboard:<repo>:<workflowId>`,
 * `wiki:<repo>:<workflowId>`, `git:<repo>:<workflowId>`,
 * `telemetry:traces:<changeId>`, `views:<repo>`. */
export type DataKey = string;

export class DataCache {
	private readonly entries = new Map<DataKey, InternalEntry>();
	private readonly listeners = new Set<(key: DataKey) => void>();
	/** Bumped on an event gap: every entry older than this is stale. */
	private epoch = 0;

	/** Reactive accessor for one key: `undefined` until a read lands. */
	read<T>(key: DataKey): CacheEntry<T> | undefined {
		return this.entry(key).signal() as CacheEntry<T> | undefined;
	}

	/** True when the key holds a value read in the current epoch. */
	has(key: DataKey): boolean {
		return this.entry(key).signal() !== undefined;
	}

	/** Read through the loader unless a fresh value is cached. A loader result
	 * that arrives after the key moved on (a newer generation) is discarded, so
	 * a slow read can never overwrite a newer selection. */
	async load<T>(
		key: DataKey,
		loader: (signal: AbortSignal) => Promise<T>,
		options: ReadOptions = {},
	): Promise<T | undefined> {
		const entry = this.entry(key);
		const cached = entry.signal() as CacheEntry<T> | undefined;
		if (
			cached &&
			!options.refresh &&
			(options.revision === undefined || cached.revision === options.revision)
		)
			return cached.value;

		const generation = ++entry.generation;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const value = await loader(controller.signal);
			// A read that started before the selection changed must not publish.
			if (entry.generation !== generation) return undefined;
			entry.set({
				value,
				...(options.revision !== undefined
					? { revision: options.revision }
					: {}),
				at: Date.now(),
			});
			this.notify(key);
			return value;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Drop one key (or every key with a prefix). */
	invalidate(key: DataKey): void {
		const entry = this.entries.get(key);
		if (entry) {
			entry.generation += 1;
			entry.set(undefined);
			this.notify(key);
			return;
		}
		for (const existing of [...this.entries.keys()])
			if (existing.startsWith(`${key}:`)) this.invalidate(existing);
	}

	clear(): void {
		for (const key of [...this.entries.keys()]) this.invalidate(key);
		this.entries.clear();
	}

	/** Apply one domain event: the resource and revision it names are stale. A
	 * workflow event invalidates that workflow's reads; an event without a
	 * resource falls back to a full invalidation rather than guessing. */
	applyEvent(event: EventEnvelope): void {
		if (event.domain === "workflow" && event.resource) {
			this.invalidate(`workflow:${event.resource}`);
			this.invalidate(`views:${event.resource}`);
			this.invalidate(`dashboard:${event.resource}`);
			this.invalidate(`wiki:${event.resource}`);
			this.invalidate(`git:${event.resource}`);
			return;
		}
		if (event.domain === "telemetry") {
			this.invalidate("telemetry");
			return;
		}
		this.clear();
	}

	/** An event gap (cursor outside the window, reconnect, overflow): every
	 * cached value is untrustworthy and the next read must be authoritative. */
	markStale(): void {
		this.epoch += 1;
		for (const key of [...this.entries.keys()]) this.invalidate(key);
	}

	get staleEpoch(): number {
		return this.epoch;
	}

	/** Subscribe to key changes (Solid components wrap this in an effect). */
	subscribe(listener: (key: DataKey) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(key: DataKey): void {
		for (const listener of this.listeners) listener(key);
	}

	private entry(key: DataKey): InternalEntry {
		const existing = this.entries.get(key);
		if (existing) return existing;
		const [signal, set] = createSignal<CacheEntry<unknown> | undefined>(
			undefined,
		);
		const created: InternalEntry = {
			signal: signal as () => CacheEntry<unknown> | undefined,
			set: set as (entry: CacheEntry<unknown> | undefined) => void,
			generation: 0,
		};
		this.entries.set(key, created);
		return created;
	}
}

/** Process-wide cache. The composition root may install a fresh one per shell. */
export const cache = new DataCache();

export function workflowKey(repo: string, workflowId: string): DataKey {
	return `workflow:${repo}:${workflowId}`;
}

export function dashboardKey(repo: string, workflowId: string): DataKey {
	return `dashboard:${repo}:${workflowId}`;
}

export function viewsKey(repo: string): DataKey {
	return `views:${repo}`;
}

/** Drop cached entries for a key (or a key prefix). The composition provider
 * exposes this so a feature can force a re-read after an event gap. */
export function invalidateKey(key: DataKey): void {
	cache.invalidate(key);
}
