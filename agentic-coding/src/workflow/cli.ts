// Barrel re-exporting the full public surface that used to live directly in
// this file, split into `cli/*.ts` by concern (split-workflow-god-modules).
// Every current importer keeps working unchanged; see
// `src/workflow/README.md` for the module map.

export {
	runDeveloperQuestion,
	validateQuestionTimeout,
} from "./cli/commands/dispatch-actions.ts";
export { listProjects } from "./cli/commands/misc.ts";
export {
	parseFusionProfiles,
	rolesForDefinition,
	validateStart,
} from "./cli/commands/start.ts";
export { detachedDrainArgv, drainEffects } from "./cli/drain.ts";
export { runGit } from "./cli/git.ts";
export { paneForRunFactory, verificationPosition } from "./cli/pane.ts";
export { engine } from "./cli/registry.ts";
export { cliTest, main, run } from "./cli/run.ts";
export {
	AGENT_EXTENSION_SUBCOMMANDS,
	PLUGIN_SUBCOMMANDS,
	REQUIRED_FLAGS,
	SUBCOMMANDS,
	WIKI_SUBCOMMANDS,
} from "./cli/schema.ts";
