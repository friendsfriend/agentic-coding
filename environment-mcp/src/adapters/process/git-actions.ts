import type {
	GitActionOutcome,
	GitActionRequest,
	GitBranch,
	GitBranches,
	GitCommit,
	GitCommitDetail,
	GitCommitFile,
	GitLog,
	GitRemote,
	GitRemotes,
	GitStash,
	GitStashes,
	GitTag,
	GitTags,
	GitWorktree,
	GitWorktrees,
	GitWriteRequest,
} from "../../domain/git-actions.ts";
import { gitPathContext } from "./git-status.ts";

const outputLimit = 64 * 1024;

async function readBounded(
	stream: ReadableStream<Uint8Array>,
	limit = outputLimit,
) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		text += decoder.decode(value, { stream: true });
		if (bytes > limit) {
			truncated = true;
			await reader.cancel().catch(() => {});
			break;
		}
	}
	text += decoder.decode();
	return { text, truncated };
}

async function capture(
	repository: string,
	args: readonly string[],
	signal: AbortSignal,
	timeoutMs: number,
) {
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = AbortSignal.any([signal, timeout]);
	const child = Bun.spawn(["git", "-C", repository, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_PAGER: "cat",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
	const stop = () => child.kill("SIGKILL");
	combined.addEventListener("abort", stop, { once: true });
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			readBounded(child.stdout),
			readBounded(child.stderr),
		]);
		return {
			code,
			stdout: stdout.text,
			stderr: stderr.text,
			truncated: stdout.truncated || stderr.truncated,
			timedOut: timeout.aborted,
		};
	} finally {
		combined.removeEventListener("abort", stop);
	}
}

export async function readGitBranches(
	repository: string,
	signal: AbortSignal,
): Promise<GitBranches> {
	try {
		const [listed, current] = await Promise.all([
			capture(
				repository,
				[
					"for-each-ref",
					"--format=%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)",
					"refs/heads",
				],
				signal,
				5000,
			),
			capture(
				repository,
				["symbolic-ref", "--short", "-q", "HEAD"],
				signal,
				3000,
			),
		]);
		if (listed.timedOut || (listed.code !== 0 && !listed.stdout))
			return { repository, branches: [], note: "unavailable" };
		const currentName = current.code === 0 ? current.stdout.trim() : undefined;
		const branches: GitBranch[] = [];
		for (const line of listed.stdout.split("\n")) {
			if (!line) continue;
			const [name = "", upstream = "", track = ""] = line.split("\0");
			if (!name) continue;
			const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
			const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
			branches.push({
				name,
				current: name === currentName,
				...(upstream ? { upstream } : {}),
				ahead,
				behind,
				...(track.includes("gone") ? { gone: true } : {}),
			});
			if (branches.length >= 200) break;
		}
		branches.sort((left, right) => {
			if (left.current !== right.current) return left.current ? -1 : 1;
			return left.name.localeCompare(right.name);
		});
		return {
			repository,
			branches,
			...(currentName ? { current: currentName } : {}),
		};
	} catch {
		return { repository, branches: [], note: "unavailable" };
	}
}

export async function readGitLog(
	repository: string,
	signal: AbortSignal,
): Promise<GitLog> {
	try {
		const listed = await capture(
			repository,
			[
				"log",
				"-n",
				"50",
				"--date=iso-strict",
				"--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%D",
			],
			signal,
			5000,
		);
		if (listed.timedOut)
			return { repository, commits: [], note: "unavailable" };
		if (listed.code !== 0 && !listed.stdout)
			return { repository, commits: [], note: "unavailable" };
		const commits: GitCommit[] = [];
		for (const line of listed.stdout.split("\n")) {
			if (!line) continue;
			const [
				sha = "",
				shortSha = "",
				author = "",
				date = "",
				subject = "",
				refs = "",
			] = line.split("\0");
			if (!sha || !shortSha) continue;
			const names = refs
				.split(",")
				.map((ref) => ref.trim())
				.filter(Boolean);
			commits.push({
				sha,
				shortSha,
				author,
				subject,
				...(date ? { date } : {}),
				...(names.length ? { refs: names } : {}),
			});
			if (commits.length >= 50) break;
		}
		return { repository, commits };
	} catch {
		return { repository, commits: [], note: "unavailable" };
	}
}

export async function readGitCommit(
	repository: string,
	sha: string,
	signal: AbortSignal,
): Promise<GitCommitDetail> {
	const unavailable = (): GitCommitDetail => ({
		sha,
		shortSha: sha.slice(0, 8),
		subject: "",
		author: "",
		parents: [],
		body: "",
		files: [],
		diff: "",
		truncated: false,
		note: "unavailable",
	});
	try {
		const metadata = await capture(
			repository,
			[
				"show",
				"-s",
				"--date=iso-strict",
				"--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%P%x00%B",
				sha,
			],
			signal,
			32_768,
		);
		if (metadata.timedOut || metadata.code !== 0 || !metadata.stdout)
			return unavailable();
		const [
			full = "",
			shortSha = "",
			author = "",
			email = "",
			date = "",
			parents = "",
			body = "",
		] = metadata.stdout.split("\0");
		if (!full) return unavailable();
		const [filesResult, diffResult] = await Promise.all([
			capture(
				repository,
				["show", "--numstat", "--format=", sha],
				signal,
				64 * 1024,
			),
			capture(
				repository,
				[
					"show",
					"--no-ext-diff",
					"--no-textconv",
					"--unified=3",
					"--format=",
					sha,
				],
				signal,
				48 * 1024,
			),
		]);
		const files: GitCommitFile[] = [];
		for (const line of filesResult.stdout.split("\n")) {
			if (!line) continue;
			const [additions = "", deletions = "", ...rest] = line.split("\t");
			const path = rest.join("\t").trim();
			if (!path) continue;
			const added = Number(additions);
			const removed = Number(deletions);
			files.push({
				path,
				...(Number.isSafeInteger(added) ? { additions: added } : {}),
				...(Number.isSafeInteger(removed) ? { deletions: removed } : {}),
				...(additions === "-" && deletions === "-" ? { binary: true } : {}),
			});
			if (files.length >= 200) break;
		}
		const message = body.trim();
		return {
			sha: full,
			shortSha,
			subject: message.split("\n")[0] ?? "",
			author,
			email,
			date,
			parents: parents.split(" ").filter(Boolean),
			body: message,
			files,
			diff: diffResult.stdout,
			truncated:
				metadata.truncated || filesResult.truncated || diffResult.truncated,
		};
	} catch {
		return unavailable();
	}
}

export async function readGitWorktrees(
	repository: string,
	signal: AbortSignal,
): Promise<GitWorktrees> {
	try {
		const listed = await capture(
			repository,
			["worktree", "list", "--porcelain"],
			signal,
			5000,
		);
		if (listed.timedOut || (listed.code !== 0 && !listed.stdout))
			return { repository, worktrees: [], note: "unavailable" };
		const root = gitPathContext(repository).root;
		const worktrees: GitWorktree[] = [];
		for (const block of listed.stdout.split("\n\n")) {
			if (!block.trim()) continue;
			const entry: GitWorktree = {
				path: "",
				detached: false,
				bare: false,
				current: false,
			};
			for (const line of block.split("\n")) {
				if (line.startsWith("worktree ")) entry.path = line.slice(9);
				else if (line.startsWith("HEAD ")) entry.head = line.slice(5);
				else if (line.startsWith("branch refs/heads/"))
					entry.branch = line.slice(18);
				else if (line === "detached") entry.detached = true;
				else if (line === "bare") entry.bare = true;
				else if (line.startsWith("locked"))
					entry.locked = line.slice(6).trim() || "locked";
				else if (line.startsWith("prunable"))
					entry.prunable = line.slice(8).trim() || "prunable";
			}
			if (!entry.path) continue;
			entry.current = entry.path === root;
			worktrees.push(entry);
			if (worktrees.length >= 100) break;
		}
		worktrees.sort((left, right) => {
			if (left.current !== right.current) return left.current ? -1 : 1;
			return left.path.localeCompare(right.path);
		});
		return { repository, worktrees };
	} catch {
		return { repository, worktrees: [], note: "unavailable" };
	}
}

function sanitizeRemoteUrl(value: string) {
	try {
		const parsed = new URL(value);
		if (
			(parsed.protocol === "https:" || parsed.protocol === "http:") &&
			(parsed.username || parsed.password)
		) {
			parsed.username = "";
			parsed.password = "";
			return parsed.toString();
		}
	} catch {
		// SSH/scp-like and local remote URLs are returned as-is.
	}
	return value;
}

export async function readGitRemotes(
	repository: string,
	signal: AbortSignal,
): Promise<GitRemotes> {
	try {
		const listed = await capture(repository, ["remote", "-v"], signal, 5000);
		if (listed.timedOut || (listed.code !== 0 && !listed.stdout))
			return { repository, remotes: [], note: "unavailable" };
		const byName = new Map<string, GitRemote>();
		for (const line of listed.stdout.split("\n")) {
			if (!line) continue;
			const match = /^(.*?)\t(.*) \((fetch|push)\)$/.exec(line);
			if (!match?.[1] || !match[2]) continue;
			const name = match[1];
			const url = sanitizeRemoteUrl(match[2]);
			const current = byName.get(name) ?? {
				name,
				fetchUrl: "",
			};
			if (match[3] === "fetch") current.fetchUrl = url;
			else if (url !== current.fetchUrl) current.pushUrl = url;
			byName.set(name, current);
		}
		return {
			repository,
			remotes: [...byName.values()]
				.filter((remote) => remote.fetchUrl)
				.sort((left, right) => left.name.localeCompare(right.name)),
		};
	} catch {
		return { repository, remotes: [], note: "unavailable" };
	}
}

export async function readGitTags(
	repository: string,
	signal: AbortSignal,
): Promise<GitTags> {
	try {
		const listed = await capture(
			repository,
			[
				"tag",
				"--list",
				"--format=%(refname:short)%00%(objectname)%00%(objecttype)%00%(creatordate:iso-strict)%00%(subject)",
			],
			signal,
			5000,
		);
		if (listed.timedOut || (listed.code !== 0 && !listed.stdout))
			return { repository, tags: [], note: "unavailable" };
		const tags: GitTag[] = [];
		for (const line of listed.stdout.split("\n")) {
			if (!line) continue;
			const [name = "", sha = "", type = "", date = "", subject = ""] =
				line.split("\0");
			if (!name || !sha) continue;
			tags.push({
				name,
				sha,
				annotated: type === "tag",
				...(date ? { date } : {}),
				...(subject ? { subject } : {}),
			});
			if (tags.length >= 200) break;
		}
		return { repository, tags };
	} catch {
		return { repository, tags: [], note: "unavailable" };
	}
}

export async function readGitStashes(
	repository: string,
	signal: AbortSignal,
): Promise<GitStashes> {
	try {
		const listed = await capture(
			repository,
			["stash", "list", "--format=%gd%x00%ci%x00%gs"],
			signal,
			5000,
		);
		if (listed.timedOut || (listed.code !== 0 && !listed.stdout))
			return { repository, stashes: [], note: "unavailable" };
		const stashes: GitStash[] = [];
		for (const line of listed.stdout.split("\n")) {
			if (!line) continue;
			const [ref = "", date = "", subject = ""] = line.split("\0");
			const match = /^stash@\{(\d+)\}$/.exec(ref);
			if (!match?.[1]) continue;
			const details = /^(?:On|WIP on) ([^:]+): ?(.*)$/.exec(subject);
			stashes.push({
				index: Number(match[1]),
				ref,
				...(details?.[1] ? { branch: details[1] } : {}),
				message: details?.[2] || subject,
				...(date ? { date } : {}),
			});
			if (stashes.length >= 100) break;
		}
		return { repository, stashes };
	} catch {
		return { repository, stashes: [], note: "unavailable" };
	}
}

function redactRemoteCredentials(value: string) {
	return value.replace(/(https?:\/\/)[^/@\s]+@/gi, "$1");
}

function reasonFrom(output: string) {
	if (
		/already checked out at|is already checked out|already used by worktree/i.test(
			output,
		)
	)
		return "branch-in-use";
	if (/contains modified or untracked files|would be overwritten/i.test(output))
		return "dirty-worktree";
	if (/already exists/i.test(output)) return "path-exists";
	if (/is a main working tree|is the current working tree/i.test(output))
		return "current-worktree";
	if (/locked working tree/i.test(output)) return "worktree-locked";
	if (
		/not a valid|did not match|unknown revision|invalid reference/i.test(output)
	)
		return "branch-not-found";
	return undefined;
}

export async function runGitAction(
	repository: string,
	request: GitActionRequest,
	signal: AbortSignal,
): Promise<GitActionOutcome> {
	let args: string[];
	let timeoutMs: number;
	switch (request.action) {
		case "fetch":
			args = ["fetch"];
			timeoutMs = 60_000;
			break;
		case "pull":
			args = ["pull", "--ff-only"];
			timeoutMs = 60_000;
			break;
		case "checkout":
			args = ["switch", request.branch];
			timeoutMs = 30_000;
			break;
		case "branch-delete":
			args = ["branch", "-d", request.branch];
			timeoutMs = 30_000;
			break;
		case "remote-add":
			args = ["remote", "add", request.name, request.url];
			timeoutMs = 30_000;
			break;
		case "remote-remove":
			args = ["remote", "remove", request.name];
			timeoutMs = 30_000;
			break;
		case "stage":
			args = ["add", "--", request.path];
			timeoutMs = 15_000;
			break;
		case "unstage":
			args = ["restore", "--staged", "--", request.path];
			timeoutMs = 15_000;
			break;
		case "stage-all":
			args = ["add", "-A"];
			timeoutMs = 30_000;
			break;
		case "unstage-all":
			args = ["reset"];
			timeoutMs = 15_000;
			break;
		case "worktree-add":
			args = ["worktree", "add"];
			if (request.create) args.push("-b", request.branch);
			args.push(request.path);
			if (!request.create) args.push(request.branch);
			timeoutMs = 30_000;
			break;
		case "worktree-remove":
			args = ["worktree", "remove", request.path];
			timeoutMs = 30_000;
			break;
	}
	try {
		const result = await capture(repository, args, signal, timeoutMs);
		const output = redactRemoteCredentials(
			[result.stdout, result.stderr]
				.filter((value) => value.trim())
				.join("\n")
				.trim(),
		);
		const reason = result.timedOut
			? "timeout"
			: result.code === 0
				? undefined
				: (reasonFrom(output) ?? "git-failed");
		return {
			repository,
			action: request.action,
			status: result.code === 0 ? "completed" : "failed",
			output,
			truncated: result.truncated,
			...(reason ? { reason } : {}),
			...(request.action === "checkout" || request.action === "branch-delete"
				? { branch: request.branch }
				: request.action === "worktree-add"
					? { branch: request.branch, path: request.path }
					: request.action === "worktree-remove"
						? { path: request.path }
						: {}),
		};
	} catch {
		return {
			repository,
			action: request.action,
			status: "failed",
			output: "",
			truncated: false,
			reason: "unavailable",
		};
	}
}

function writeReason(action: GitWriteRequest["action"], output: string) {
	if (action === "merge" && /CONFLICT|Automatic merge failed/i.test(output))
		return "merge-conflict";
	if (
		action === "rebase" &&
		/CONFLICT|could not apply|Resolve all conflicts/i.test(output)
	)
		return "rebase-conflict";
	if (
		action === "push" &&
		/Authentication failed|Permission denied|could not read Username|terminal prompts disabled/i.test(
			output,
		)
	)
		return "authentication-required";
	if (
		action === "push" &&
		/does not appear to be a git repository|Could not read from remote/i.test(
			output,
		)
	)
		return "remote-unavailable";
	if (
		(action === "push" || action === "push-force") &&
		/rejected|non-fast-forward|failed to push/i.test(output)
	)
		return "push-rejected";
	if (action === "push-force" && /stale info|force-with-lease/i.test(output))
		return "force-lease-stale";
	if (action === "rebase-abort" && /no rebase in progress/i.test(output))
		return "no-rebase";
	if (action === "commit" && /nothing to commit|no changes added/i.test(output))
		return "nothing-to-commit";
	if (
		action === "commit" &&
		/Please tell me who you are|Author identity unknown/i.test(output)
	)
		return "identity-missing";
	if (action === "stash" && /No local changes/i.test(output))
		return "nothing-to-stash";
	if (action === "tag" && /already exists/i.test(output)) return "tag-exists";
	if (action === "tag-delete" && /not found|did not match/i.test(output))
		return "tag-not-found";
	if (
		(action === "stash-pop" ||
			action === "stash-apply" ||
			action === "stash-drop") &&
		/no stash entries|not a valid reference/i.test(output)
	)
		return "stash-not-found";
	if (action === "branch-rename" && /already exists/i.test(output))
		return "branch-exists";
	if (action === "remote-set-url" && /No such remote/i.test(output))
		return "remote-not-found";
	return undefined;
}

function writeArgs(
	request: GitWriteRequest,
	lease?: string,
): {
	args: string[];
	timeoutMs: number;
} {
	switch (request.action) {
		case "push":
			return {
				args: [
					"push",
					...(request.setUpstream ? ["-u"] : []),
					request.remote,
					request.branch,
				],
				timeoutMs: 120_000,
			};
		case "push-force":
			return {
				args: [
					"push",
					`--force-with-lease=${request.branch}:${lease ?? ""}`,
					request.remote,
					request.branch,
				],
				timeoutMs: 120_000,
			};
		case "tag":
			return {
				args: request.message
					? ["tag", "-a", request.name, "-m", request.message]
					: ["tag", request.name],
				timeoutMs: 30_000,
			};
		case "tag-delete":
			return { args: ["tag", "-d", request.name], timeoutMs: 30_000 };
		case "stash-pop":
			return {
				args: ["stash", "pop", `stash@{${request.index}}`],
				timeoutMs: 60_000,
			};
		case "stash-apply":
			return {
				args: ["stash", "apply", `stash@{${request.index}}`],
				timeoutMs: 60_000,
			};
		case "stash-drop":
			return {
				args: ["stash", "drop", `stash@{${request.index}}`],
				timeoutMs: 30_000,
			};
		case "branch-rename":
			return {
				args: ["branch", "-m", request.branch, request.name],
				timeoutMs: 30_000,
			};
		case "remote-set-url":
			return {
				args: ["remote", "set-url", request.name, request.url],
				timeoutMs: 30_000,
			};
		case "commit":
		case "commit-all":
			return { args: ["commit", "-m", request.message], timeoutMs: 60_000 };
		case "stash":
			return {
				args: [
					"stash",
					"push",
					...(request.message ? ["-m", request.message] : []),
				],
				timeoutMs: 60_000,
			};
		case "merge":
			return {
				args: ["merge", "--no-edit", request.branch],
				timeoutMs: 60_000,
			};
		case "rebase":
			return { args: ["rebase", request.branch], timeoutMs: 60_000 };
		case "rebase-abort":
			return { args: ["rebase", "--abort"], timeoutMs: 60_000 };
	}
}

export async function runGitWrite(
	repository: string,
	request: GitWriteRequest,
	signal: AbortSignal,
): Promise<GitActionOutcome> {
	try {
		if (request.action === "commit-all") {
			const staged = await capture(repository, ["add", "-A"], signal, 30_000);
			if (staged.code !== 0) {
				const output = redactRemoteCredentials(staged.stderr.trim());
				return {
					repository,
					action: request.action,
					status: "failed",
					output,
					truncated: staged.truncated,
					reason: staged.timedOut ? "timeout" : "git-failed",
				};
			}
		}
		const lease = request.action === "push-force" ? request.lease : undefined;
		if (request.action === "push-force" && !lease)
			return {
				repository,
				action: request.action,
				status: "failed",
				output: "",
				truncated: false,
				reason: "force-lease-missing",
			};
		const { args, timeoutMs } = writeArgs(request, lease);
		const result = await capture(repository, args, signal, timeoutMs);
		const output = redactRemoteCredentials(
			[result.stdout, result.stderr]
				.filter((value) => value.trim())
				.join("\n")
				.trim(),
		);
		const reason = result.timedOut
			? "timeout"
			: result.code === 0
				? undefined
				: (writeReason(request.action, output) ?? "git-failed");
		let head: string | undefined;
		if (
			(request.action === "commit" || request.action === "commit-all") &&
			result.code === 0
		) {
			const resolved = await capture(
				repository,
				["rev-parse", "HEAD"],
				signal,
				3000,
			);
			if (resolved.code === 0) head = resolved.stdout.trim() || undefined;
		}
		return {
			repository,
			action: request.action,
			status: result.code === 0 ? "completed" : "failed",
			output,
			truncated: result.truncated,
			...(reason ? { reason } : {}),
			...(request.action === "push" || request.action === "branch-rename"
				? { branch: request.action === "push" ? request.branch : request.name }
				: {}),
			...(head ? { head } : {}),
		};
	} catch {
		return {
			repository,
			action: request.action,
			status: "failed",
			output: "",
			truncated: false,
			reason: "unavailable",
		};
	}
}
