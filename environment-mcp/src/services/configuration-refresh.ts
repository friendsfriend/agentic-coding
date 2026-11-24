import fs from "node:fs";
import type { ServerManifest } from "../configuration/server-manifest.ts";
import { readV2Configuration } from "../configuration/v2-configuration.ts";
import { OperationRefusal } from "../domain/operation.ts";

/** Synchronous validation and publication: no admission can interleave between
 * the idle check and the swap. Authorization is fixed for the server lifetime. */
export function createConfigurationRefresh(options: {
	configDir: string;
	repositories: readonly string[];
	isIdle(): boolean;
	apply(manifest: ServerManifest): void;
}) {
	return () => {
		if (!options.isIdle()) throw new OperationRefusal("configuration-busy");
		let next: ServerManifest;
		try {
			next = readV2Configuration(options.configDir);
			if (
				JSON.stringify(next.repositories) !==
					JSON.stringify(options.repositories) ||
				next.repositories.some(
					(root) =>
						fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory(),
				)
			)
				throw new Error("Authorization changed");
		} catch {
			throw new OperationRefusal("configuration-refresh-invalid");
		}
		options.apply(next);
		return {
			refreshed: true,
			applications: next.apps.length,
			runtimeChecked: false,
			authorizationChanged: false,
			secretsReloaded: false,
		};
	};
}
