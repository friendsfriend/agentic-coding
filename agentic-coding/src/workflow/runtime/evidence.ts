// Git inspection, source-content fingerprinting, changed-file discovery,
// current-branch lookup, and wiki baseline/verification content reads — all
// external-I/O reads with no dependency on the engine's transactional state.
// Moved verbatim out of runtime.ts (split-workflow-god-modules).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JsonValue, WorkflowSnapshot } from "../contracts.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import {
	conceptPath,
	listConcepts,
	snapshotList,
	wikiBundleFingerprint,
	wikiConceptFingerprint,
	wikiRoot,
} from "../wiki.ts";
import type { StartWorkflowInput } from "./engine-types.ts";
import { wikiWorkflowDataRoot } from "./targets.ts";

export function samePath(left: string, right: string): boolean {
	try {
		return fs.realpathSync(left) === fs.realpathSync(right);
	} catch {
		return path.resolve(left) === path.resolve(right);
	}
}
function withWikiRoot<T>(root: string, operation: () => T): T {
	const previous = process.env.HERDR_WIKI_DIR;
	process.env.HERDR_WIKI_DIR = root;
	try {
		return operation();
	} finally {
		if (previous === undefined) delete process.env.HERDR_WIKI_DIR;
		else process.env.HERDR_WIKI_DIR = previous;
	}
}

const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_LIST_BYTES = 8 * 1024 * 1024;
function gitNullSeparated(repository: string, args: string[]): string[] {
	const result = Bun.spawnSync(["git", "-C", repository, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new WorkflowRuntimeError(
			"source-isolation",
			`unable to fingerprint Git content: ${result.stderr.toString().trim()}`,
		);
	if (result.stdout.byteLength > MAX_SOURCE_LIST_BYTES)
		throw new WorkflowRuntimeError(
			"source-isolation",
			"source listing exceeds bounded observation size",
		);
	return result.stdout.toString().split("\0").filter(Boolean);
}
function sourcePathExcluded(
	repository: string,
	relative: string,
	configuredWikiPath = wikiRoot(),
): boolean {
	const absolute = path.resolve(repository, relative);
	const workflowRoot = path.resolve(repository, ".herdr-workflow");
	if (
		absolute === workflowRoot ||
		absolute.startsWith(`${workflowRoot}${path.sep}`)
	)
		return true;
	const repositoryRoot = path.resolve(repository);
	const configuredWiki = path.resolve(configuredWikiPath);
	const wikiIsInsideRepository =
		configuredWiki !== repositoryRoot &&
		configuredWiki.startsWith(`${repositoryRoot}${path.sep}`);
	return (
		wikiIsInsideRepository &&
		(absolute === configuredWiki ||
			absolute.startsWith(`${configuredWiki}${path.sep}`))
	);
}
/** Fingerprint source content and index state while excluding engine bookkeeping
 * and a centralized wiki bundle if it happens to live under the repository. */
export function sourceContentFingerprint(
	repository: string,
	configuredWikiPath = wikiRoot(),
): string {
	const tracked = [
		...gitNullSeparated(repository, ["ls-files", "-z", "--cached"]),
		...gitNullSeparated(repository, [
			"ls-files",
			"-z",
			"--others",
			"--exclude-standard",
		]),
		...gitNullSeparated(repository, [
			"ls-files",
			"-z",
			"--others",
			"--ignored",
			"--exclude-standard",
		]),
	].filter(
		(relative) =>
			sourcePathExcluded(repository, relative, configuredWikiPath) === false,
	);
	const staged = gitNullSeparated(repository, ["ls-files", "--stage", "-z"])
		.filter((entry) => {
			const separator = entry.indexOf("\t");
			return (
				separator >= 0 &&
				sourcePathExcluded(
					repository,
					entry.slice(separator + 1),
					configuredWikiPath,
				) === false
			);
		})
		.sort();
	const hash = createHash("sha256");
	for (const entry of staged) hash.update(`index:${entry.length}:${entry}\0`);
	for (const relative of [...new Set(tracked)].sort()) {
		hash.update(`path:${relative.length}:${relative}\0`);
		const file = path.join(repository, relative);
		try {
			const stat = fs.lstatSync(file);
			if (stat.isSymbolicLink()) {
				const target = fs.readlinkSync(file);
				hash.update(`symlink:${target.length}:${target}\0`);
			} else if (stat.isFile()) {
				let fd: number | undefined;
				try {
					fd = fs.openSync(
						file,
						fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
					);
					const current = fs.fstatSync(fd);
					if (!current.isFile() || current.size > MAX_SOURCE_FILE_BYTES)
						throw new WorkflowRuntimeError(
							"source-isolation",
							`source file exceeds bounded observation size: ${relative}`,
						);
					const buffer = Buffer.alloc(MAX_SOURCE_FILE_BYTES + 1);
					const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
					if (bytesRead > MAX_SOURCE_FILE_BYTES)
						throw new WorkflowRuntimeError(
							"source-isolation",
							`source file exceeds bounded observation size: ${relative}`,
						);
					const content = buffer.subarray(0, bytesRead);
					hash.update(`file:${content.length}:`);
					hash.update(content);
					hash.update("\0");
				} finally {
					if (fd !== undefined) fs.closeSync(fd);
				}
			} else hash.update(`mode:${stat.mode}\0`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			hash.update("missing\0");
		}
	}
	return hash.digest("hex");
}
export function changedFilesIn(snapshot: WorkflowSnapshot): string[] {
	const root = snapshot.metadata.worktree;
	const changed = new Set<string>();
	const addTree = (relative: string): void => {
		const entries = fs.readdirSync(path.join(root, relative), {
			withFileTypes: true,
		});
		for (const entry of entries) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) addTree(child);
			else changed.add(child);
		}
	};
	const result = Bun.spawnSync(["git", "-C", root, "status", "--porcelain"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	for (const line of result.stdout.toString().split("\n").filter(Boolean)) {
		const relative = line.slice(3).replace(/\/$/, "");
		let stat: fs.Stats | undefined;
		try {
			stat = fs.statSync(path.join(root, relative));
		} catch {
			/* missing on disk (e.g. deleted); keep the entry as-is */
		}
		if (stat?.isDirectory()) addTree(relative);
		else changed.add(relative);
	}
	const committed = Bun.spawnSync(
		[
			"git",
			"-C",
			root,
			"diff",
			"--name-only",
			`${snapshot.metadata.baseCommit}..HEAD`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	for (const file of committed.stdout.toString().split("\n").filter(Boolean))
		changed.add(file);
	return [...changed].sort();
}
export async function changedFilesInAsync(
	snapshot: WorkflowSnapshot,
): Promise<string[]> {
	const root = snapshot.metadata.worktree;
	const runGit = async (args: string[]) => {
		const proc = Bun.spawn(["git", "-C", root, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0)
			throw new Error("unable to inspect changed files");
		return stdout;
	};
	const changed = new Set<string>();
	for (const line of (
		await runGit(["status", "--porcelain=v1", "-uall"])
	).split("\n")) {
		if (line.trim()) changed.add(line.slice(3));
	}
	for (const file of (
		await runGit([
			"diff",
			"--name-only",
			`${snapshot.metadata.baseCommit}..HEAD`,
		])
	).split("\n"))
		if (file) changed.add(file);
	return [...changed].sort();
}
export function currentBranch(repo: string): string | undefined {
	const result = Bun.spawnSync(
		["git", "-C", repo, "branch", "--show-current"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	return result.exitCode === 0
		? result.stdout.toString().trim() || undefined
		: undefined;
}
export function wikiBaselineFor(
	root: string,
	context: JsonValue | undefined,
): WorkflowSnapshot["wikiBaseline"] {
	const comments =
		context && typeof context === "object" && !Array.isArray(context)
			? (context as { comments?: unknown }).comments
			: undefined;
	const allowed = new Set(
		Array.isArray(comments)
			? comments.flatMap((comment) =>
					comment && typeof comment === "object" && "conceptId" in comment
						? [String((comment as { conceptId: unknown }).conceptId)]
						: [],
				)
			: [],
	);
	return {
		fingerprint: wikiBundleFingerprint(root, allowed),
		concepts: listConcepts().map((concept) => ({
			id: concept.id,
			digest: wikiConceptFingerprint(concept.id, root) ?? "",
		})),
	};
}
function wikiReviewConceptIds(
	snapshot: WorkflowSnapshot,
): Set<string> | undefined {
	if (snapshot.definition.id !== "wiki-comments") return undefined;
	const context = snapshot.step.context;
	const comments =
		context && typeof context === "object" && !Array.isArray(context)
			? (context as { comments?: unknown }).comments
			: undefined;
	return new Set(
		Array.isArray(comments)
			? comments.flatMap((comment) =>
					comment && typeof comment === "object" && "conceptId" in comment
						? [String((comment as { conceptId: unknown }).conceptId)]
						: [],
				)
			: [],
	);
}
export function wikiVerificationPayload(snapshot: WorkflowSnapshot): {
	concepts: Array<{ id: string; digest: string }>;
} {
	const pinnedRoot = path.resolve(snapshot.metadata.wikiRoot ?? wikiRoot(true));
	if (!samePath(wikiRoot(), pinnedRoot))
		throw new WorkflowRuntimeError(
			"wiki-root",
			"wiki root does not match the pinned workflow wiki root",
		);
	return withWikiRoot(pinnedRoot, () => {
		const all = snapshotList(
			// The wiki snapshot keys on the recorded change when one exists
			// (openspec workflows) and on the workflow id otherwise (wiki-only
			// and research workflows have no planner to record a change).
			snapshot.metadata.changeId || snapshot.workflowId,
			snapshot.definition.id === "wiki-comments" ||
				snapshot.definition.id === "research"
				? wikiWorkflowDataRoot()
				: snapshot.metadata.worktree,
		);
		const requested = wikiReviewConceptIds(snapshot);
		if (requested && all.some((id) => !requested.has(id)))
			throw new WorkflowRuntimeError(
				"wiki-scope",
				"wiki agent touched a concept outside submitted comments",
			);
		return {
			concepts: all
				.filter((id) => !requested || requested.has(id))
				.map((id) => ({
					id,
					digest: createHash("sha256")
						.update(fs.readFileSync(conceptPath(id)))
						.digest("hex"),
				})),
		};
	});
}
export function validateSourceBaseline(
	snapshot: WorkflowSnapshot,
): string | undefined {
	if (
		snapshot.definition.id !== "wiki" &&
		snapshot.definition.id !== "research"
	)
		return undefined;
	if (snapshot.definition.id === "research" && !snapshot.metadata.repository)
		return undefined;
	const baseline = snapshot.sourceBaseline?.fingerprint;
	if (!baseline)
		throw new WorkflowRuntimeError(
			"source-isolation",
			`${snapshot.definition.id} source baseline is missing`,
		);
	const fingerprint = sourceContentFingerprint(
		snapshot.metadata.repository,
		snapshot.metadata.wikiRoot,
	);
	if (fingerprint !== baseline)
		throw new WorkflowRuntimeError(
			"source-isolation",
			"source repository changed during documentation or research run",
		);
	return fingerprint;
}
export function validateStartEvidence(
	repository: string,
	input: StartWorkflowInput,
	proposal = false,
): void {
	const status = Bun.spawnSync(
		["git", "-C", repository, "status", "--porcelain"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (status.exitCode !== 0)
		throw new WorkflowRuntimeError(
			"start-guard",
			"unable to inspect Git worktree",
		);
	if (
		status.stdout.toString().trim() &&
		!proposal &&
		input.definitionId !== "wiki"
	)
		throw new WorkflowRuntimeError(
			"start-guard",
			"working tree must be clean before workflow start",
		);
	if (input.definitionId === "wiki") {
		if (!input.metadata.task?.trim())
			throw new WorkflowRuntimeError(
				"start-guard",
				"wiki requires non-empty task",
			);
		return;
	}
	if (input.definitionId === "no-openspec") {
		if (!input.metadata.task?.trim())
			throw new WorkflowRuntimeError(
				"start-guard",
				"no-openspec requires non-empty task",
			);
		return;
	}
	if (!fs.existsSync(path.join(repository, "openspec", "config.yaml")))
		throw new WorkflowRuntimeError("start-guard", "OpenSpec project required");
	if (input.definitionId === "openspec-apply") {
		const root = path.join(repository, "openspec", "changes", input.workflowId);
		for (const file of ["proposal.md", "design.md", "tasks.md"])
			if (
				!fs.existsSync(path.join(root, file)) ||
				!fs.readFileSync(path.join(root, file), "utf8").trim()
			)
				throw new WorkflowRuntimeError(
					"start-guard",
					`invalid openspec-apply artifact: ${file}`,
				);
		if (
			!/^\s*[-*]\s+\[ \]/m.test(
				fs.readFileSync(path.join(root, "tasks.md"), "utf8"),
			)
		)
			throw new WorkflowRuntimeError(
				"start-guard",
				"openspec-apply requires actionable unchecked task",
			);
	}
}
