// Environment home/configuration resolution (moved out of the retired
// managed-Go-backend boundary). Pure path resolution: the one executable and
// every subprocess it starts resolve the same directories through this module.
//
// The root `.env` is read through the one shared contract (`src/env-file.ts`,
// unify-json-configuration-directory task 3.1); this module no longer carries a
// second parser.
import os from "node:os";
import path from "node:path";
import {
	configRootEnv,
	ROOT_SELECTING_ENV_KEYS,
	resolveConfigRoot,
	warnRootSelectingKeyInEnvFile,
} from "../config-root.ts";
import { expandEnvHome, loadEnvFile } from "../env-file.ts";

/** The one configuration root every global consumer shares. */
export function resolveConfigDir(explicit?: string): string {
	return resolveConfigRoot(explicit);
}

/** Environment fragment that makes an application subprocess resolve the same
 * configuration root as this process. */
export function configDirEnv(
	root = resolveConfigRoot(),
): Record<string, string> {
	return configRootEnv(root);
}

/** Resolve the managed runtime home: `DEVENV_HOME`, then `DEVENV_HOME` in the
 * selected root's `.env` (with its bootstrap `$HOME` expansion), then
 * `~/devenv`. This is the runtime location, not the configuration root. */
export function resolveDevenvHome(): string {
	if (process.env.DEVENV_HOME) return process.env.DEVENV_HOME;
	const envVars = loadEnvFile(path.join(resolveConfigDir(), ".env"));
	// A root `.env` must not select the root that contains it.
	for (const key of ROOT_SELECTING_ENV_KEYS) {
		if (envVars.delete(key)) warnRootSelectingKeyInEnvFile(key);
	}
	const configured = envVars.get("DEVENV_HOME");
	if (configured !== undefined && configured !== "")
		return expandEnvHome(configured);
	return path.join(os.homedir(), "devenv");
}
