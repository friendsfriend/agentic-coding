// Review-feature data reads (establish-opencode-boundaries, task 4.5).
//
// The review surfaces read best-effort: a superseded or cancelled read must
// leave the dialog usable rather than hand the caller `undefined`. These
// wrappers give that shape a name, over the same cache-backed selectors.
import type { LocalChange } from "../../contracts/integration.ts";
import type {
	DeveloperReviewComment,
	DeveloperReviewFinding,
	PlanReviewComment,
	WikiReviewComment,
	WorkflowState,
} from "../../contracts/workflow.ts";
import {
	loadArtifact,
	loadLocalChanges,
	loadLocalDiff,
	loadWikiChanges,
	loadWikiDiff,
} from "./git.ts";
import {
	loadDeveloperReviewFindings,
	runWorkflow,
	saveDeveloperReview,
	savePlanReview,
	saveWikiReview,
} from "./workflow.ts";

export { runWorkflow, saveDeveloperReview, savePlanReview, saveWikiReview };

/** Changed files in the worktree (empty when the read was superseded). */
export async function loadLocalChangesOrEmpty(
	repo: string,
	workflowId: string,
	signal?: AbortSignal,
): Promise<LocalChange[]> {
	return (await loadLocalChanges(repo, workflowId, signal)) ?? [];
}

/** Wiki snapshot changes (empty when the read was superseded). */
export async function loadWikiChangesOrEmpty(
	repo: string,
	workflowId: string,
	signal?: AbortSignal,
): Promise<LocalChange[]> {
	return (await loadWikiChanges(repo, workflowId, signal)) ?? [];
}

/** One worktree diff (empty when the read was superseded). */
export async function loadLocalDiffOrEmpty(
	repo: string,
	workflowId: string,
	file: LocalChange,
	signal?: AbortSignal,
): Promise<string> {
	return (await loadLocalDiff(repo, workflowId, file, signal)) ?? "";
}

/** One wiki diff (empty when the read was superseded). */
export async function loadWikiDiffOrEmpty(
	repo: string,
	workflowId: string,
	file: LocalChange,
	signal?: AbortSignal,
): Promise<string> {
	return (await loadWikiDiff(repo, workflowId, file, signal)) ?? "";
}

/** One artifact body (empty when the read was superseded). */
export async function loadArtifactOrEmpty(
	state: WorkflowState,
	artifact: string,
	signal?: AbortSignal,
): Promise<string> {
	return (await loadArtifact(state, artifact, signal)) ?? "";
}

/** Developer-review findings for the review dialog. */
export async function loadReviewFindings(
	repo: string,
	workflowId: string,
	signal?: AbortSignal,
): Promise<DeveloperReviewFinding[]> {
	return (
		(await loadDeveloperReviewFindings<DeveloperReviewFinding[]>(
			repo,
			workflowId,
			signal,
		)) ?? []
	);
}

export type { DeveloperReviewComment, PlanReviewComment, WikiReviewComment };
