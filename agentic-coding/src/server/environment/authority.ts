// Composition of the Bun-owned environment authority: the state store at
// `$DEVENV_HOME/db/state.db` plus the configured-environment manager that owns
// the definition files and the catalog projection.
import path from "node:path";
import { EnvironmentManager } from "./manager.ts";
import type { EnvironmentAuthority } from "./private-api.ts";
import { EnvironmentStateStore } from "./state-store.ts";

export interface EnvironmentAuthorityOptions {
	readonly homeDir: string;
	readonly configDir: string;
	/** Injected store (tests, or a read-only observation). */
	readonly store?: EnvironmentStateStore;
	readonly logger?: (message: string) => void;
	/**
	 * `owner` refreshes branches and backfills missing runtime columns (this
	 * process is the writer); `catalog` is the bounded read-only load that never
	 * mutates the environment.
	 */
	readonly mode?: "owner" | "catalog";
}

export function environmentStateDir(homeDir: string): string {
	return path.join(homeDir, "db");
}

/**
 * Open the environment authority and publish its first snapshot. This is the
 * single environment state/config owner: a database of another schema version
 * is refused rather than converted, so any change of state format is a
 * deliberate out-of-band restore.
 */
export function createEnvironmentAuthority(
	options: EnvironmentAuthorityOptions,
): EnvironmentAuthority {
	const store =
		options.store ??
		EnvironmentStateStore.open(environmentStateDir(options.homeDir));
	const manager = new EnvironmentManager({
		homeDir: options.homeDir,
		configDir: options.configDir,
		store,
		...(options.logger ? { logger: options.logger } : {}),
	});
	if ((options.mode ?? "owner") === "catalog") manager.loadCatalogConfig();
	else manager.loadConfig();
	return { state: store, manager };
}
