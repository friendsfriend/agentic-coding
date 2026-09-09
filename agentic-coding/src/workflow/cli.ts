// Barrel re-exporting the full public surface that used to live directly in
// this file, split into `cli/*.ts` by concern (split-workflow-god-modules).
// Every current importer keeps working unchanged; see
// `src/workflow/README.md` for the module map. The in-process engine factory,
// effect draining, and project listing moved to the application-operations
// boundary (`src/workflow/operations.ts`, enforce-source-layer-boundaries)
// and are no longer part of the CLI surface.

export {
	runDeveloperQuestion,
	validateQuestionTimeout,
} from "./cli/commands/dispatch-actions.ts";
export {
	parseFusionProfiles,
	rolesForDefinition,
	validateStart,
} from "./cli/commands/start.ts";
export { detachedDrainArgv, scheduleDrain } from "./cli/drain.ts";
export { runGit } from "./cli/git.ts";
export { paneForRunFactory, verificationPosition } from "./cli/pane.ts";
export { cliTest, main, run } from "./cli/run.ts";
export {
	AGENT_EXTENSION_SUBCOMMANDS,
	PLUGIN_SUBCOMMANDS,
	REQUIRED_FLAGS,
	SUBCOMMANDS,
	WIKI_SUBCOMMANDS,
} from "./cli/schema.ts";
