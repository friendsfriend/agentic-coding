// Internal `__catalog` mode: print the canonical project catalog as JSON.
//
// This is the bounded read-only invocation `loadProjectCatalog` falls back to
// when no server is running. It opens the environment authority in its
// read-only catalog mode, so the projection is produced by the same
// implementation that serves `/api/projects` — never a second discovery path,
// and never a compiler or second runtime.
import { resolveConfigDir, resolveDevenvHome } from "../backend/home.ts";
import { createEnvironmentAuthority } from "./environment/authority.ts";
import { newProjectCatalog } from "./environment/config.ts";

export async function printProjectCatalog(): Promise<void> {
	try {
		const authority = createEnvironmentAuthority({
			homeDir: resolveDevenvHome(),
			configDir: resolveConfigDir(),
			mode: "catalog",
			logger: (message) => process.stderr.write(`${message}\n`),
		});
		try {
			// The same envelope `/api/projects` serves: the revision is what
			// clients compare to detect a configured-project change.
			process.stdout.write(
				`${JSON.stringify(newProjectCatalog([...authority.manager.getProjectCatalog()]))}\n`,
			);
		} finally {
			authority.state.close();
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
