import { type Accessor, createMemo, createSignal, type Setter } from "solid-js";

export interface KeyedItem<T> {
	readonly key: string;
	readonly value: Accessor<T>;
}

/** Original shared live-row composition: keep containers under a stable
 * presentation key, not a freshly projected object. Keys are UI memory, not
 * native authority. Updating an item's signal keeps siblings/parent mounted. */
export function createKeyedItems<T>(
	items: Accessor<readonly T[]>,
	identify: (item: T, index: number) => string,
): Accessor<readonly KeyedItem<T>[]> {
	const slots = new Map<string, KeyedItem<T> & { set: Setter<T> }>();
	return createMemo(() => {
		const used = new Set<string>();
		const counts = new Map<string, number>();
		const result = items().map((item, index) => {
			const id = identify(item, index);
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
