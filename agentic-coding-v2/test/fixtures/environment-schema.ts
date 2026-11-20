import path from "node:path";
import type { Config } from "../../src/config.ts";
import { validateProjects } from "../../src/environment/catalog.ts";

// Schema validation is data-only. This deliberately nonexistent repository must
// not require a Git checkout, model, runtime, native store, listener or engine.
export const schemaRepository = path.resolve("unused-schema-repository");
const config: Config = {
	repositories: [schemaRepository],
	profiles: [],
	orchestratorProfile: "unused",
	providers: [],
	skills: [],
	stateDir: path.resolve("unused-schema-state"),
	configDir: path.resolve("unused-schema-config"),
};
export function environmentSchema(
	targets: Record<string, unknown>[],
	kind = "app",
) {
	return validateProjects(config, {
		version: 1,
		projects: [{ id: "api", kind, repository: schemaRepository, targets }],
	});
}
