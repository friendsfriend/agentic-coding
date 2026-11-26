import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	readGitBranches,
	readGitCommit,
	readGitLog,
	readGitRemotes,
	readGitStashes,
	readGitTags,
	readGitWorktrees,
	runGitAction,
	runGitWrite,
} from "../adapters/process/git-actions.ts";
import {
	gitPathContext,
	readGitChanges,
} from "../adapters/process/git-status.ts";
import type {
	GitActionOutcome,
	GitActionPort,
	GitRemotes,
	GitWriteRequest,
} from "../domain/git-actions.ts";
import { OperationRefusal } from "../domain/operation.ts";

function refused(
	repository: string,
	action: string,
	reason: string,
	extra: Partial<GitActionOutcome> = {},
): GitActionOutcome {
	return {
		repository,
		action,
		status: "refused",
		output: "",
		truncated: false,
		reason,
		...extra,
	};
}

function validRemoteName(value: string) {
	return Boolean(
		value &&
			!value.startsWith("-") &&
			!value.includes("\0") &&
			!value.includes("\n") &&
			!value.includes("\r"),
	);
}

function validRemoteUrl(value: string) {
	if (
		!value ||
		value.length > 4096 ||
		value.startsWith("-") ||
		value.includes("\0") ||
		value.includes("\n") ||
		value.includes("\r")
	)
		return false;
	try {
		const parsed = new URL(value);
		if (
			(parsed.protocol === "https:" || parsed.protocol === "http:") &&
			(parsed.username || parsed.password)
		)
			return false;
	} catch {
		// SSH/scp-like and local paths are allowed.
	}
	return true;
}

function validPath(value: string) {
	return (
		path.isAbsolute(value) &&
		!value.includes("\0") &&
		!value.includes("\n") &&
		!value.includes("\r")
	);
}

function validRequestId(value: string) {
	return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validRefName(
	repository: string,
	name: string,
	kind: "branch" | "tag",
) {
	if (!name || name.startsWith("-") || name.length > 255) return false;
	const check = Bun.spawnSync(
		[
			"git",
			"-C",
			repository,
			"check-ref-format",
			...(kind === "tag" ? [`refs/tags/${name}`] : ["--branch", name]),
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	return check.exitCode === 0;
}

function rebaseInProgress(repository: string) {
	const resolved = Bun.spawnSync(
		["git", "-C", repository, "rev-parse", "--git-path", "rebase-merge"],
		{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
	);
	const apply = Bun.spawnSync(
		["git", "-C", repository, "rev-parse", "--git-path", "rebase-apply"],
		{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
	);
	return [resolved, apply].some((entry) => {
		if (entry.exitCode !== 0) return false;
		const value = entry.stdout.toString().trim();
		if (!value) return false;
		const target = path.isAbsolute(value)
			? value
			: path.join(repository, value);
		return fs.existsSync(target);
	});
}

function refExists(repository: string, ref: string) {
	const check = Bun.spawnSync(
		["git", "-C", repository, "rev-parse", "--verify", "--quiet", ref],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	return check.exitCode === 0;
}

function resolveForceLease(repository: string, remote: string, branch: string) {
	const result = Bun.spawnSync(
		[
			"git",
			"-C",
			repository,
			"rev-parse",
			"--verify",
			`refs/remotes/${remote}/${branch}`,
		],
		{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
	);
	if (result.exitCode !== 0) return undefined;
	const value = result.stdout.toString().trim();
	return /^[a-f0-9]{40,64}$/.test(value) ? value : undefined;
}

function writeDigest(repository: string, request: GitWriteRequest) {
	return createHash("sha256")
		.update(JSON.stringify([repository, request]))
		.digest("hex");
}

function writeTarget(request: GitWriteRequest) {
	if (request.action === "push")
		return `${request.branch} → ${request.remote}${request.setUpstream ? " (set upstream)" : ""}`;
	if (request.action === "push-force")
		return `${request.branch} → ${request.remote} (force-with-lease @${request.lease?.slice(0, 8) ?? "missing"})`;
	if (request.action === "tag") return request.name;
	if (request.action === "tag-delete") return request.name;
	if (
		request.action === "stash-pop" ||
		request.action === "stash-apply" ||
		request.action === "stash-drop"
	)
		return `stash@{${request.index}}`;
	if (request.action === "branch-rename")
		return `${request.branch} → ${request.name}`;
	if (request.action === "remote-set-url") return request.name;
	if (request.action === "commit") return "staged changes";
	if (request.action === "commit-all") return "all changes";
	if (request.action === "stash") return "working tree";
	if (request.action === "rebase-abort") return "current rebase";
	return request.branch;
}

type CachedWrite = { digest: string; outcome?: GitActionOutcome };

export function createGitActionService(): GitActionPort {
	const pending = new Set<string>();
	const writes = new Map<string, CachedWrite>();
	return {
		branches(repository, signal) {
			return readGitBranches(repository, signal);
		},
		worktrees(repository, signal) {
			return readGitWorktrees(repository, signal);
		},
		remotes(repository, signal) {
			return readGitRemotes(repository, signal);
		},
		log(repository, signal) {
			return readGitLog(repository, signal);
		},
		commit(repository, sha, signal) {
			return readGitCommit(repository, sha, signal);
		},
		tags(repository, signal) {
			return readGitTags(repository, signal);
		},
		stashes(repository, signal) {
			return readGitStashes(repository, signal);
		},
		async run(repository, request, signal) {
			const context = gitPathContext(repository);
			const key = `${context.root}\0${context.prefix}`;
			if (pending.has(key)) return refused(repository, request.action, "busy");
			pending.add(key);
			try {
				if (request.action === "fetch")
					return await runGitAction(repository, request, signal);
				if (request.action === "stage" || request.action === "unstage") {
					if (
						!request.path ||
						request.path.startsWith("/") ||
						request.path.includes("\0") ||
						request.path.split("/").includes("..")
					)
						return refused(repository, request.action, "path-invalid");
					const changes = await readGitChanges(repository, signal);
					if (changes.note)
						return refused(repository, request.action, "unavailable");
					const change = changes.changes.find(
						(entry) => entry.path === request.path,
					);
					if (!change)
						return refused(repository, request.action, "path-not-found");
					if (request.action === "unstage" && !change.staged)
						return refused(repository, request.action, "not-staged");
					return await runGitAction(repository, request, signal);
				}
				if (request.action === "stage-all" || request.action === "unstage-all")
					return await runGitAction(repository, request, signal);
				if (request.action === "pull") {
					const changes = await readGitChanges(context.root, signal);
					if (changes.note)
						return refused(repository, request.action, "unavailable");
					if (changes.changes.length > 0)
						return refused(repository, request.action, "dirty-worktree");
					return await runGitAction(repository, request, signal);
				}
				const branches = await readGitBranches(repository, signal);
				if (branches.note)
					return refused(repository, request.action, "unavailable");
				if (request.action === "checkout") {
					const target = branches.branches.find(
						(branch) => branch.name === request.branch,
					);
					if (!target)
						return refused(repository, request.action, "branch-not-found");
					if (target.current)
						return {
							repository,
							action: request.action,
							status: "completed",
							output: `Already on ${request.branch}`,
							truncated: false,
							branch: request.branch,
						};
					const changes = await readGitChanges(context.root, signal);
					if (changes.note)
						return refused(repository, request.action, "unavailable");
					if (changes.changes.length > 0)
						return refused(repository, request.action, "dirty-worktree");
					return await runGitAction(repository, request, signal);
				}
				if (request.action === "branch-delete") {
					const target = branches.branches.find(
						(branch) => branch.name === request.branch,
					);
					if (!target)
						return refused(repository, request.action, "branch-not-found");
					if (target.current)
						return refused(repository, request.action, "current-branch");
					return await runGitAction(repository, request, signal);
				}
				if (request.action === "remote-add") {
					if (!validRemoteName(request.name) || !validRemoteUrl(request.url))
						return refused(repository, request.action, "remote-invalid");
					const remotes: GitRemotes = await readGitRemotes(repository, signal);
					if (remotes.note)
						return refused(repository, request.action, "unavailable");
					if (remotes.remotes.some((remote) => remote.name === request.name))
						return refused(repository, request.action, "remote-exists");
					return await runGitAction(repository, request, signal);
				}
				if (request.action === "remote-remove") {
					if (!validRemoteName(request.name))
						return refused(repository, request.action, "remote-invalid");
					const remotes: GitRemotes = await readGitRemotes(repository, signal);
					if (remotes.note)
						return refused(repository, request.action, "unavailable");
					if (!remotes.remotes.some((remote) => remote.name === request.name))
						return refused(repository, request.action, "remote-not-found");
					return await runGitAction(repository, request, signal);
				}
				if (request.action === "worktree-add") {
					if (!validPath(request.path))
						return refused(repository, request.action, "path-invalid");
					const target = path.resolve(request.path);
					const parent = path.dirname(target);
					if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory())
						return refused(repository, request.action, "path-invalid");
					if (fs.existsSync(target))
						return refused(repository, request.action, "path-exists");
					const relative = path.relative(context.root, target);
					if (!relative?.startsWith(".."))
						return refused(repository, request.action, "path-invalid");
					if (!request.branch || request.branch.startsWith("-"))
						return refused(repository, request.action, "branch-invalid");
					const exists = branches.branches.some(
						(branch) => branch.name === request.branch,
					);
					if (request.create) {
						if (exists)
							return refused(repository, request.action, "branch-exists");
						const check = Bun.spawnSync(
							[
								"git",
								"-C",
								repository,
								"check-ref-format",
								"--branch",
								request.branch,
							],
							{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
						);
						if (check.exitCode !== 0)
							return refused(repository, request.action, "branch-invalid");
					} else if (!exists) {
						return refused(repository, request.action, "branch-not-found");
					}
					return await runGitAction(repository, request, signal);
				}
				if (!validPath(request.path))
					return refused(repository, request.action, "path-invalid");
				const target = path.resolve(request.path);
				const worktrees = await readGitWorktrees(repository, signal);
				if (worktrees.note)
					return refused(repository, request.action, "unavailable");
				const worktree = worktrees.worktrees.find(
					(entry) => path.resolve(entry.path) === target,
				);
				if (!worktree)
					return refused(repository, request.action, "worktree-not-found");
				if (worktree.current)
					return refused(repository, request.action, "current-worktree");
				const worktreeChanges = await readGitChanges(worktree.path, signal);
				if (worktreeChanges.note)
					return refused(repository, request.action, "unavailable");
				if (worktreeChanges.changes.length > 0)
					return refused(repository, request.action, "dirty-worktree");
				return await runGitAction(
					repository,
					{ action: "worktree-remove", path: worktree.path },
					signal,
				);
			} finally {
				pending.delete(key);
			}
		},
		async write(repository, request, requestId, confirm, signal) {
			if (!validRequestId(requestId))
				throw new OperationRefusal("provider-invalid");
			const context = gitPathContext(repository);
			const key = `${context.root}\0${requestId}`;
			let resolved = request;
			if (request.action === "push-force") {
				const lease = resolveForceLease(
					context.root,
					request.remote,
					request.branch,
				);
				if (!lease) throw new OperationRefusal("force-lease-missing");
				resolved = { ...request, lease };
			}
			const digest = writeDigest(context.root, resolved);
			if (confirm !== digest)
				return {
					status: "confirmation-required",
					digest,
					intent: {
						repository,
						action: resolved.action,
						target: writeTarget(resolved),
					},
				};
			const existing = writes.get(key);
			if (existing) {
				if (existing.digest !== digest)
					throw new OperationRefusal("request-conflict");
				if (!existing.outcome)
					throw new OperationRefusal("git-write-in-progress");
				return { status: "replayed", digest, outcome: existing.outcome };
			}
			const lockKey = `${context.root}\0${context.prefix}`;
			if (pending.has(lockKey))
				throw new OperationRefusal("git-write-in-progress");
			pending.add(lockKey);
			writes.set(key, { digest });
			if (writes.size > 200) {
				const oldest = writes.keys().next().value;
				if (oldest) writes.delete(oldest);
			}
			try {
				const refusal = await validateWrite(
					repository,
					context.root,
					resolved,
					signal,
				);
				let outcome: GitActionOutcome;
				if (refusal) {
					outcome = refused(repository, request.action, refusal);
				} else {
					outcome = await runGitWrite(repository, resolved, signal);
					if (
						outcome.status === "completed" &&
						(request.action === "branch-rename" ||
							request.action === "commit" ||
							request.action === "merge" ||
							request.action === "rebase")
					) {
						const branches = await readGitBranches(repository, signal);
						if (branches.current)
							outcome = { ...outcome, branch: branches.current };
					}
				}
				const cached = writes.get(key);
				if (cached) cached.outcome = outcome;
				return { status: "completed", digest, outcome };
			} catch (error) {
				writes.delete(key);
				throw error;
			} finally {
				pending.delete(lockKey);
			}
		},
	};
}

async function validateWrite(
	repository: string,
	root: string,
	request: GitWriteRequest,
	signal: AbortSignal,
): Promise<string | undefined> {
	const branches = await readGitBranches(repository, signal);
	if (branches.note) return "unavailable";
	if (request.action === "push" || request.action === "push-force") {
		const branch = branches.branches.find(
			(entry) => entry.name === request.branch,
		);
		if (!branch) return "branch-not-found";
		if (!validRemoteName(request.remote)) return "remote-invalid";
		const remotes = await readGitRemotes(repository, signal);
		if (remotes.note) return "unavailable";
		if (!remotes.remotes.some((remote) => remote.name === request.remote))
			return "remote-not-found";
		if (
			request.action === "push-force" &&
			branch.upstream !== `${request.remote}/${request.branch}`
		)
			return "force-lease-missing";
		return undefined;
	}
	if (request.action === "tag") {
		if (!validRefName(repository, request.name, "tag")) return "tag-invalid";
		if (refExists(repository, `refs/tags/${request.name}`)) return "tag-exists";
		return undefined;
	}
	if (request.action === "tag-delete") {
		if (!validRefName(repository, request.name, "tag")) return "tag-invalid";
		if (!refExists(repository, `refs/tags/${request.name}`))
			return "tag-not-found";
		return undefined;
	}
	if (
		request.action === "stash-pop" ||
		request.action === "stash-apply" ||
		request.action === "stash-drop"
	) {
		const stashes = await readGitStashes(repository, signal);
		if (stashes.note) return "unavailable";
		if (
			!stashes.stashes.some(
				(stash: { index: number }) => stash.index === request.index,
			)
		)
			return "stash-not-found";
		return undefined;
	}
	if (request.action === "branch-rename") {
		const branch = branches.branches.find(
			(entry) => entry.name === request.branch,
		);
		if (!branch) return "branch-not-found";
		if (!validRefName(repository, request.name, "branch"))
			return "branch-invalid";
		if (request.name === request.branch) return "branch-exists";
		if (branches.branches.some((entry) => entry.name === request.name))
			return "branch-exists";
		return undefined;
	}
	if (request.action === "remote-set-url") {
		if (!validRemoteName(request.name) || !validRemoteUrl(request.url))
			return "remote-invalid";
		const remotes = await readGitRemotes(repository, signal);
		if (remotes.note) return "unavailable";
		if (!remotes.remotes.some((remote) => remote.name === request.name))
			return "remote-not-found";
		return undefined;
	}
	if (
		request.action === "commit" ||
		request.action === "commit-all" ||
		request.action === "stash"
	) {
		const changes = await readGitChanges(root, signal);
		if (changes.note) return "unavailable";
		if (request.action === "commit") {
			if (!changes.changes.some((change) => change.staged))
				return "nothing-staged";
			return undefined;
		}
		if (changes.changes.length === 0)
			return request.action === "commit-all"
				? "nothing-to-commit"
				: "nothing-to-stash";
		return undefined;
	}
	if (request.action === "rebase-abort") {
		if (rebaseInProgress(repository)) return undefined;
		return "no-rebase";
	}
	if (!branches.current) return "detached-head";
	const branch = branches.branches.find(
		(entry) => entry.name === request.branch,
	);
	if (!branch) return "branch-not-found";
	if (branch.current) return "current-branch";
	const changes = await readGitChanges(root, signal);
	if (changes.note) return "unavailable";
	if (changes.changes.length > 0) return "dirty-worktree";
	return undefined;
}
