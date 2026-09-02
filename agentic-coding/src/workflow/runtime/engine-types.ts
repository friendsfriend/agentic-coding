// Public request/result shapes for the engine's API, factored out so leaf
// modules (evidence.ts needs StartWorkflowInput for validateStartEvidence)
// can reference them without importing engine.ts itself. Moved verbatim out
// of runtime.ts (split-workflow-god-modules).
import type {
	JsonValue,
	WorkflowEffect,
	WorkflowSnapshot,
	WorkflowView,
} from "../contracts.ts";

export interface StartWorkflowInput {
	/** Canonical repository path, WIKI_WORKFLOW_TARGET, or RESEARCH_WORKFLOW_TARGET. */
	repo: string;
	/** Optional source repository used as read-only evidence by research. */
	repositoryContext?: string;
	/** Initial input retained in the current step as untrusted context. */
	context?: JsonValue;
	worktree?: string;
	/** User-supplied workflow identifier; the store row is keyed by it. */
	workflowId: string;
	definitionId: string;
	definitionVersion?: number;
	mode?: "worktree" | "checkout";
	sameCheckout?: boolean;
	metadata: Omit<
		WorkflowSnapshot["metadata"],
		| "repository"
		| "worktree"
		| "changeId"
		| "createdAt"
		| "updatedAt"
		| "stepEnteredAt"
	>;
	routing: WorkflowSnapshot["routing"];
}
export interface DispatchResult {
	snapshot: WorkflowSnapshot;
	view: WorkflowView;
}
export interface ClaimedEffect extends WorkflowEffect {
	runToken?: string;
}
export interface RepairPreview {
	targetStep: string;
	label: string;
	expiresRuns: string[];
	retainedEvidence: string[];
}
