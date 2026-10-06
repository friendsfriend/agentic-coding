// Shell app actions (establish-opencode-boundaries, tasks 5.6/6.4).
//
// Application-level operations a feature triggers but does not own: workflow
// engine actions, artifact opening and agent preset helpers. Features import them here
// (or through their own re-export) instead of reaching the server or the
// workflow runtime, and the composition root remains the only place that
// constructs services.

export {
	listPresetNames,
	onWorkflowExecutionError,
	onWorkflowExecutionProgress,
	onWorkflowExecutionSettled,
	PRESET_CONFIG_DEFAULTS,
	presetCatalog,
	requestWorkflowExecution,
	startWikiCommentWorkflowInProcess,
	switchWorkflowPreset,
	workflowExecutionError,
} from "../../server/operations/engine.ts";
export {
	discoverBranches as discoverBranchesLocal,
	discoverChanges as discoverChangesLocal,
	openSpecArtifact,
	openSpecArtifacts,
} from "../../server/operations/observations.ts";
export { PUBLIC_WORKFLOW_CATALOG } from "../../workflow/definitions.ts";
export { saveSidebarMode } from "../../workflow/effects.ts";
export {
	serverOwnsExecutionEvents,
	subscribeDataEvents,
} from "../data/events.ts";
