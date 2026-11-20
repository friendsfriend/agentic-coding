import type { EnvironmentPersistence } from "./persistence.ts";
import type { EnvironmentProcess } from "./process.ts";
import type { EnvironmentRun } from "./state.ts";
/** Server-private live capabilities, never a serializable permission or saved lease. */
export type LiveEnvironmentAuthority = {
	store: () => EnvironmentPersistence;
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
