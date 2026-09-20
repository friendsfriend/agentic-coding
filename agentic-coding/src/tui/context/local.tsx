// Route-local state (establish-opencode-boundaries, task 5.2).
//
// Filters, drafts, modal and journey values belong to one destination: they are
// keyed by route identity, never mixed with server data, and dropped when the
// shell unmounts so a later visit starts clean.

import type { JSX } from "solid-js";
import { createContext, onCleanup, useContext } from "solid-js";

export interface LocalSurface {
	get<T>(key: string): T | undefined;
	set<T>(key: string, value: T): void;
	clear(key: string): void;
	clearAll(): void;
	keys(): string[];
}

export function createLocalState(): LocalSurface {
	const entries = new Map<string, unknown>();
	return {
		get: <T,>(key: string) => entries.get(key) as T | undefined,
		set: <T,>(key: string, value: T) => {
			entries.set(key, value);
		},
		clear: (key) => {
			entries.delete(key);
		},
		clearAll: () => entries.clear(),
		keys: () => [...entries.keys()],
	};
}

const LocalContext = createContext<LocalSurface>();

export function LocalProvider(props: {
	readonly surface?: LocalSurface;
	readonly children: JSX.Element;
}): JSX.Element {
	const local = props.surface ?? createLocalState();
	// An unmount must not retain unrelated local state.
	onCleanup(() => local.clearAll());
	return (
		<LocalContext.Provider value={local}>
			{props.children}
		</LocalContext.Provider>
	);
}

export function useLocal(): LocalSurface {
	const surface = useContext(LocalContext);
	if (!surface)
		throw new Error("LocalProvider is missing above this component");
	return surface;
}
