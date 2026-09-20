// Git and wiki observation selectors (establish-opencode-boundaries, task 4.2).
//
// Worktree status/diff and wiki concept/render/snapshot reads through the
// gateway. Selectors expose contract data and take callbacks; they never touch
// the filesystem, a Git process or a Herdr socket.
import {
	diffBodySchema,
	type LocalChange,
	localChangesSchema,
	pathListSchema,
	type WorktreeGitStatus,
} from "../../contracts/integration.ts";
import type { WorkflowState } from "../../contracts/workflow.ts";
import { cache, gateway } from "./index.ts";

type Signal = AbortSignal | undefined;

export function gitKey(repo: string, workflowId: string): string {
	return `git:${repo}:${workflowId}`;
}

export function wikiKey(repo: string, workflowId: string): string {
	return `wiki:${repo}:${workflowId}`;
}

/** Changed files in a workflow's worktree, cached per workflow. */
export async function loadLocalChanges(
	repo: string,
	workflowId: string,
	signal?: Signal,
): Promise<LocalChange[] | undefined> {
	return cache.load(
		`${gitKey(repo, workflowId)}:changes`,
		(signal) =>
			gateway().observe<LocalChange[]>(
				{ kind: "local-changes", repo, workflowId },
				localChangesSchema,
				signal,
			),
		{ signal },
	);
}

/** One file's diff from the worktree. */
export async function loadLocalDiff(
	repo: string,
	workflowId: string,
	file: LocalChange,
	signal?: Signal,
): Promise<string | undefined> {
	return cache.load(
		`${gitKey(repo, workflowId)}:diff:${file.newPath}`,
		(signal) =>
			gateway().observe<string>(
				{ kind: "local-diff", repo, workflowId, file },
				diffBodySchema,
				signal,
			),
		{ signal },
	);
}

/** Wiki snapshot changes for a workflow. */
export async function loadWikiChanges(
	repo: string,
	workflowId: string,
	signal?: Signal,
): Promise<LocalChange[] | undefined> {
	return cache.load(
		`${wikiKey(repo, workflowId)}:changes`,
		(signal) =>
			gateway().observe<LocalChange[]>(
				{ kind: "wiki-changes", repo, workflowId },
				localChangesSchema,
				signal,
			),
		{ signal },
	);
}

/** One wiki file's diff. */
export async function loadWikiDiff(
	repo: string,
	workflowId: string,
	file: LocalChange,
	signal?: Signal,
): Promise<string | undefined> {
	return cache.load(
		`${wikiKey(repo, workflowId)}:diff:${file.newPath}`,
		(signal) =>
			gateway().observe<string>(
				{ kind: "wiki-diff", repo, workflowId, file },
				diffBodySchema,
				signal,
			),
		{ signal },
	);
}

/** OpenSpec artifacts of a workflow state (change proposals and specs). */
export async function loadArtifacts(
	state: WorkflowState,
	signal?: Signal,
): Promise<string[] | undefined> {
	return cache.load(
		`artifacts:${state.repository}:${state.workflowId}`,
		(signal) =>
			gateway().observe<string[]>(
				{ kind: "artifacts", state },
				pathListSchema,
				signal,
			),
		{ signal },
	);
}

/** One artifact's content. */
export async function loadArtifact(
	state: WorkflowState,
	artifact: string,
	signal?: Signal,
): Promise<string | undefined> {
	return cache.load(
		`artifacts:${state.repository}:${state.workflowId}:${artifact}`,
		(signal) =>
			gateway().observe<string>(
				{ kind: "artifact-content", state, artifact },
				diffBodySchema,
				signal,
			),
		{ signal },
	);
}

/** Changed files a workflow touched, as the change list reports them. */
export async function loadChanges(
	repo: string,
	signal?: Signal,
): Promise<string[] | undefined> {
	return cache.load(
		`changes:${repo}`,
		(signal) =>
			gateway().observe<string[]>(
				{ kind: "changes", repo },
				pathListSchema,
				signal,
			),
		{ signal },
	);
}

/** The worktree's Git state as the dashboard projection reports it: read
 * through the dashboard observation so the selector needs no Git process. */
export function gitStatusOf(dashboard: {
	gitStatus: WorktreeGitStatus;
}): WorktreeGitStatus {
	return dashboard.gitStatus;
}
