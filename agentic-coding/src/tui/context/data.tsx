// Server-data surface (establish-opencode-boundaries, task 5.2).
//
// The cache-backed selectors, exposed through a provider so a feature consumes
// data without importing the layer (and a test can render one with a different
// surface). Server data is the only thing here: route-local values live in
// `local.ts`.

import type { JSX } from "solid-js";
import { createContext, useContext } from "solid-js";
import * as git from "../data/git.ts";
import * as herdr from "../data/herdr.ts";
import * as data from "../data/index.ts";
import * as telemetry from "../data/telemetry.ts";
import * as workflow from "../data/workflow.ts";

export interface DataSurface {
	readonly workflow: typeof workflow;
	readonly git: typeof git;
	readonly telemetry: typeof telemetry;
	readonly herdr: typeof herdr;
	/** Drop cached entries for a key (or a key prefix) after an event gap. */
	readonly invalidate: (key: string) => void;
}

const DataContext = createContext<DataSurface>();

export function DataProvider(props: {
	readonly surface?: DataSurface;
	readonly children: JSX.Element;
}): JSX.Element {
	const surface: DataSurface = props.surface ?? {
		workflow,
		git,
		telemetry,
		herdr,
		invalidate: (key) => data.invalidateKey(key),
	};
	return (
		<DataContext.Provider value={surface}>
			{props.children}
		</DataContext.Provider>
	);
}

export function useData(): DataSurface {
	const surface = useContext(DataContext);
	if (!surface) throw new Error("DataProvider is missing above this component");
	return surface;
}
