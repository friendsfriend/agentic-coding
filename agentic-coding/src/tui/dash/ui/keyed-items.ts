import { type Accessor, createMemo, createSignal, type Setter } from "solid-js";

export interface KeyedItem<T> {
	readonly key: string;
	readonly value: Accessor<T>;
}

/** Keep containers keyed by durable identity, not by a freshly projected data
 * object. Updating one item's signal doesn't remount its siblings or parent. */
export function createKeyedItems<T>(
	items: Accessor<readonly T[]>,
	identify: (item: T) => string,
): Accessor<readonly KeyedItem<T>[]> {
	const slots = new Map<string, KeyedItem<T> & { set: Setter<T> }>();
	return createMemo(() => {
		const used = new Set<string>();
		const counts = new Map<string, number>();
		const result = items().map((item) => {
			const id = identify(item);
			const occurrence = counts.get(id) ?? 0;
			counts.set(id, occurrence + 1);
			const key = `${id}\u0000${occurrence}`;
			used.add(key);
			const before = slots.get(key);
			if (before) {
				before.set(() => item);
				return before;
			}
			const [value, set] = createSignal(item);
			const slot = { key, value, set };
			slots.set(key, slot);
			return slot;
		});
		for (const key of slots.keys()) if (!used.has(key)) slots.delete(key);
		return result;
	});
}
