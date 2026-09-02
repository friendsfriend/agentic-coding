// Barrel re-exporting the full public surface that used to live directly in
// this file, split into `runtime/*.ts` by concern (split-workflow-god-modules).
// Every current importer keeps working unchanged; see
// `src/workflow/README.md` for the module map.
export { WorkflowRuntimeError } from "./contracts.ts";
export {
	MAX_DEVELOPER_DIALOGUE_RECORDS,
	QUESTION_WAIT_MS,
} from "./runtime/dialogue.ts";
export { WorkflowEngine } from "./runtime/engine.ts";
export type {
	ClaimedEffect,
	DispatchResult,
	RepairPreview,
	StartWorkflowInput,
} from "./runtime/engine-types.ts";
export {
	changedFilesIn,
	sourceContentFingerprint,
} from "./runtime/evidence.ts";
export { fusionPlannerRoles } from "./runtime/kernel.ts";
export {
	canonicalRepository,
	canonicalStorePath,
	isResearchWorkflowTarget,
	isWikiWorkflowTarget,
	RESEARCH_WORKFLOW_TARGET,
	researchWorkflowTarget,
	validateChangeId,
	validateWorkflowId,
	WIKI_WORKFLOW_TARGET,
	wikiWorkflowDataRoot,
	wikiWorkflowTarget,
} from "./runtime/targets.ts";

import {
	hashToken,
	MAX_ARTIFACT_BYTES,
	tokenMatches,
} from "./runtime/capability.ts";
import { resolveArrivalContext } from "./runtime/kernel.ts";

export const runtimeTest = {
	hashToken,
	tokenMatches,
	MAX_ARTIFACT_BYTES,
	resolveArrivalContext,
};
