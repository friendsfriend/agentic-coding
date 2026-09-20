// Shell app actions (establish-opencode-boundaries, tasks 5.6/6.4).
//
// Application-level operations a feature triggers but does not own: workflow
// engine actions, sidebar presentation, pane focus, artifact opening, agent
// preset helpers and the Herdr socket subscription. Features import them here
// (or through their own re-export) instead of reaching the server or the
// workflow runtime, and the composition root remains the only place that
// constructs services.

export {
	herdrEventMatchesWorkspace,
	subscribeHerdrEvents,
} from "../../server/herdr-events.ts";
export {
	listPresetNames,
	onWorkflowExecutionError,
	onWorkflowExecutionSettled,
	PRESET_CONFIG_DEFAULTS,
	reconcileSidebarPresentation,
	requestWorkflowExecution,
	startSidebarPresentation,
	startWikiCommentWorkflowInProcess,
	switchWorkflowPreset,
	workflowExecutionError,
} from "../../server/operations/engine.ts";
export {
	discoverChanges as discoverChangesLocal,
	focusAgentAsync,
	focusReturnWorkspace,
	focusWorkspace,
	openFindingInEditorAsync,
	openSpecArtifact,
	openSpecArtifacts,
} from "../../server/operations/observations.ts";
export { PUBLIC_WORKFLOW_CATALOG } from "../../workflow/definitions.ts";
export {
	serverOwnsExecutionEvents,
	subscribeDataEvents,
} from "../data/events.ts";
