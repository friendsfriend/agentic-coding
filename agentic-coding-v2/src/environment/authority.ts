import type { Harness } from "@earendil-works/pi-durable";
import type { EnvironmentProcess } from "./process.ts";
import type { EnvironmentRun } from "./state.ts";
/** Server-private live capabilities, never a serializable permission or saved lease. */
export type LiveEnvironmentAuthority = {
	store: () => Harness;
	records: () => Promise<EnvironmentRun[]>;
	live: ReadonlyMap<string, EnvironmentProcess>;
	pending: Map<
		Promise<unknown>,
		{ owner: number; batch: string; runId?: string }
	>;
	check: (
		owner: number,
		signal?: AbortSignal,
		batch?: string,
		run?: EnvironmentRun,
	) => void;
};
