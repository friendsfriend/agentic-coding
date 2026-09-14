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
	/** Take a consistent pre-upgrade backup before the first write. */
	readonly backup?: boolean;
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
 * Who owns the environment state. Bun owns it by default; `DEVENV_ENVIRONMENT_OWNER=go`
 * keeps the previous single-owner generation for one release, for a deliberate
 * rollback. The two generations never run as writers at the same time: in
 * migrated mode the Go child opens no database handle and reaches state/catalog
 * through the private operations only.
 */
export function bunOwnsEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return (env.DEVENV_ENVIRONMENT_OWNER ?? "bun").trim().toLowerCase() !== "go";
}

/** Open the Bun-owned authority and publish its first snapshot. */
export function createEnvironmentAuthority(
	options: EnvironmentAuthorityOptions,
): EnvironmentAuthority {
	const store =
		options.store ??
		EnvironmentStateStore.open(environmentStateDir(options.homeDir), {
			backup: options.backup,
		});
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
