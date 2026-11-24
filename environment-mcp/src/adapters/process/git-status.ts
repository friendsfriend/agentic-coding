import fs from "node:fs";
import path from "node:path";
import {
	type GitChange,
	type GitChanges,
	type GitDiff,
	type GitRepositoryStatus,
	parseGitChangesOutput,
	parseGitStatusOutput,
	unknownGitStatus,
} from "../../domain/git-status.ts";

const statusLimit = 256 * 1024;
const changesLimit = 512 * 1024;
const diffLimit = 48 * 1024;

function pathContext(repository: string) {
	const root = Bun.spawnSync(
		["git", "-C", repository, "rev-parse", "--show-toplevel"],
		{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
	);
	const prefix = Bun.spawnSync(
		["git", "-C", repository, "rev-parse", "--show-prefix"],
		{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
	);
	const top =
		root.exitCode === 0
			? root.stdout.toString().trim() || repository
			: repository;
	const raw = prefix.exitCode === 0 ? prefix.stdout.toString().trim() : "";
	return {
		root: top,
		prefix: raw ? (raw.endsWith("/") ? raw : `${raw}/`) : "",
	};
}

function stripPrefix(directory: string, prefix: string) {
	if (!prefix) return directory;
	return directory.startsWith(prefix)
		? directory.slice(prefix.length)
		: undefined;
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number) {
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

async function runGit(
	repository: string,
	args: readonly string[],
	signal: AbortSignal,
	timeoutMs: number,
	limit: number,
) {
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = AbortSignal.any([signal, timeout]);
	const child = Bun.spawn(["git", "-C", repository, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const stop = () => child.kill("SIGKILL");
	combined.addEventListener("abort", stop, { once: true });
	try {
		const [code, output] = await Promise.all([
			child.exited,
			readBounded(child.stdout, limit),
		]);
		return { code, ...output, timedOut: timeout.aborted };
	} finally {
		combined.removeEventListener("abort", stop);
	}
}

/** Read-only, bounded git observation. Never fetches, checks out or writes. */
export async function readGitStatus(
	repository: string,
	signal: AbortSignal,
): Promise<GitRepositoryStatus> {
	try {
		const result = await runGit(
			repository,
			["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
			signal,
			3000,
			statusLimit,
		);
		if (result.timedOut) return unknownGitStatus(repository, "timeout");
		if (result.code !== 0 && !result.text.includes("# branch."))
			return unknownGitStatus(repository, "not-a-repository");
		return parseGitStatusOutput(repository, result.text);
	} catch {
		return unknownGitStatus(repository, "unavailable");
	}
}

export async function readGitChanges(
	repository: string,
	signal: AbortSignal,
): Promise<GitChanges> {
	try {
		const result = await runGit(
			repository,
			["status", "--porcelain=v2", "--branch", "-z"],
			signal,
			3000,
			changesLimit,
		);
		if (result.timedOut || (result.code !== 0 && !result.text.includes("#")))
			return {
				repository,
				changes: [],
				truncated: false,
				note: "unavailable",
			};
		const parsed = parseGitChangesOutput(repository, result.text);
		const { prefix } = pathContext(repository);
		const changes = prefix
			? parsed.changes.flatMap((change) => {
					const relative = stripPrefix(change.path, prefix);
					if (!relative) return [];
					const original = change.originalPath
						? stripPrefix(change.originalPath, prefix)
						: undefined;
					return [
						{
							...change,
							path: relative,
							...(original ? { originalPath: original } : {}),
						},
					];
				})
			: parsed.changes;
		return {
			...parsed,
			changes,
			truncated: parsed.truncated || result.truncated,
		};
	} catch {
		return {
			repository,
			changes: [],
			truncated: false,
			note: "unavailable",
		};
	}
}

function safeRelativePath(value: string) {
	if (
		!value ||
		value.startsWith("/") ||
		value.includes("\0") ||
		value.split("/").includes("..")
	)
		return undefined;
	return value;
}

export async function readGitDiff(
	repository: string,
	change: GitChange,
	signal: AbortSignal,
): Promise<GitDiff> {
	const relative = safeRelativePath(change.path);
	const unavailable = (note: GitDiff["note"]): GitDiff => ({
		repository,
		path: change.path,
		diff: "",
		binary: false,
		truncated: false,
		...(note ? { note } : {}),
	});
	if (!relative) return unavailable("invalid-path");
	const context = pathContext(repository);
	const rootRelative = context.prefix
		? `${context.prefix}${relative}`
		: relative;
	let args: string[];
	if (change.kind === "untracked") {
		const absolute = path.join(context.root, rootRelative);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(absolute);
		} catch {
			return unavailable("unavailable");
		}
		if (stat.isSymbolicLink()) return unavailable("symlink");
		if (!stat.isFile()) return unavailable("directory");
		args = [
			"diff",
			"--no-index",
			"--no-ext-diff",
			"--no-textconv",
			"--unified=3",
			"--",
			"/dev/null",
			absolute,
		];
	} else {
		const head = Bun.spawnSync(
			["git", "-C", repository, "rev-parse", "--verify", "HEAD"],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		args = [
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--unified=3",
			...(head.exitCode === 0 ? ["HEAD"] : ["--cached"]),
			"--",
			rootRelative,
		];
	}
	try {
		const result = await runGit(context.root, args, signal, 10_000, diffLimit);
		if (result.timedOut) return unavailable("unavailable");
		if (result.code !== 0 && result.code !== 1 && !result.text)
			return unavailable("unavailable");
		const binary =
			result.text.includes("Binary files ") ||
			result.text.includes("GIT binary patch");
		return {
			repository,
			path: change.path,
			diff: result.text,
			binary,
			truncated: result.truncated,
			...(result.text ? {} : { note: "no-change" }),
		};
	} catch {
		return unavailable("unavailable");
	}
}
