import type { WorktreeInfo } from "@devenv/types";
import type { ClientDeps } from "./client-types";
import { handleFetchError } from "./error-handler";

async function startGitAction(
	deps: ClientDeps,
	appIdent: string,
	action: string,
	inputs: Record<string, unknown> = {},
): Promise<void> {
	const actionId = `app/${appIdent}/action/${action}/git/default`;
	const response = await deps.fetchFn(`${deps.baseUrl}/api/action-runs`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ actionId, inputs }),
	});
	if (!response.ok) await handleFetchError(response, deps.onError);
}

/**
 * Perform git pull operation on an app's repository
 */
export async function gitPull(
	deps: ClientDeps,
	appIdent: string,
): Promise<void> {
	await startGitAction(deps, appIdent, "pull");
}

/**
 * Perform git push operation on an app's repository
 */
export async function gitPush(
	deps: ClientDeps,
	appIdent: string,
): Promise<void> {
	await startGitAction(deps, appIdent, "push");
}

/**
 * Perform git fetch operation on an app's repository
 */
export async function gitFetch(
	deps: ClientDeps,
	appIdent: string,
): Promise<void> {
	await startGitAction(deps, appIdent, "fetch");
}

/**
 * Get branches for an app's repository
 */
export async function getBranches(
	deps: ClientDeps,
	appIdent: string,
): Promise<{
	appIdent: string;
	currentBranch: string;
	localBranches: string[];
	remoteBranches: string[];
}> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/git/branches?appIdent=${encodeURIComponent(appIdent)}`,
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	const data = await response.json();

	if (data.error) {
		throw new Error(data.error);
	}

	return data;
}

/**
 * Perform git checkout operation to switch branches
 */
export async function gitCheckout(
	deps: ClientDeps,
	appIdent: string,
	branch: string,
): Promise<void> {
	await startGitAction(deps, appIdent, "checkout", { branch });
}

/**
 * List all worktrees for a worktree-mode app.
 */
export async function listWorktrees(
	deps: ClientDeps,
	appIdent: string,
): Promise<WorktreeInfo[]> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/git/worktrees?appIdent=${encodeURIComponent(appIdent)}`,
	);
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	const data = await response.json();
	return (data.worktrees ?? []) as WorktreeInfo[];
}

/**
 * Remove a linked worktree for a worktree-mode app.
 */
export async function removeWorktree(
	deps: ClientDeps,
	appIdent: string,
	branch: string,
): Promise<void> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/git/worktrees?appIdent=${encodeURIComponent(appIdent)}&branch=${encodeURIComponent(branch)}`,
		{ method: "DELETE" },
	);
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}

/**
 * Create a new linked worktree for an app and set it as the active worktree.
 */
export async function createWorktree(
	deps: ClientDeps,
	appIdent: string,
	branch: string,
): Promise<void> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/git/worktrees`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ appIdent, branch }),
	});
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}

/**
 * Switch the active worktree for an app to an existing linked worktree.
 * No git operation is performed — the directory must already exist on disk.
 */
export async function switchWorktree(
	deps: ClientDeps,
	appIdent: string,
	branch: string,
): Promise<void> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/git/worktrees`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ appIdent, branch }),
	});
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}

/**
 * Create a new local branch for a branch-mode app (git checkout -b <name>).
 */
export async function gitCreateBranch(
	deps: ClientDeps,
	appIdent: string,
	branchName: string,
): Promise<void> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/git/branches`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ appIdent, branchName }),
	});
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}
