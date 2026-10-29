// Git inspection, source-content fingerprinting, changed-file discovery,
// current-branch lookup, and wiki baseline/verification content reads — all
// external-I/O reads with no dependency on the engine's transactional state.
// Moved verbatim out of runtime.ts (split-workflow-god-modules).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JsonValue, WorkflowSnapshot } from "../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import { effectiveFamilyTraits } from "../definitions/manifest-policy.ts";
import type { WorkflowManifestPolicy } from "../registry.ts";
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
const MAX_DEBUG_PATCH_BYTES = 4 * 1024 * 1024;

/** Run one git command in a repository, returning stdout, and throw the same
 * `source-isolation` error the fingerprint reader uses when it fails. */
function gitText(repository: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", repository, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new WorkflowRuntimeError(
			"source-isolation",
			`git ${args[0]} failed: ${result.stderr.toString().trim()}`,
		);
	return result.stdout.toString();
}

/** `git diff --no-index` exits 1 when the two inputs differ, which is the
 * normal case for a new file: the difference is the result, not a failure. */
function gitDiffNoIndex(repository: string, file: string): string {
	const result = Bun.spawnSync(
		["git", "-C", repository, "diff", "--no-index", "--", "/dev/null", file],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0 && result.exitCode !== 1)
		throw new WorkflowRuntimeError(
			"source-isolation",
			`git diff --no-index failed: ${result.stderr.toString().trim()}`,
		);
	return result.stdout.toString();
}

/** The debug family's handoff patch: everything the detached worktree changed
 * against `HEAD`, untracked files included. The patch is computed without
 * touching the worktree's git index — untracked files are rendered with
 * `git diff --no-index` instead of being marked intent-to-add — so a rejected
 * handoff leaves no index mutation behind. Before the diff is read at all, the
 * changed content is measured **by bytes** and the patch is skipped with a
 * bounded diagnostic when it exceeds the bound; the byte bound below still
 * trims a diff that grew past its inputs. */
export function debugChangesPatch(worktree: string): string | undefined {
	const untracked = gitNullSeparated(worktree, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	]).filter(
		(file) =>
			file !== ".herdr-workflow" && !file.startsWith(".herdr-workflow/"),
	);
	if (debugChangedContentAboveBound(worktree, untracked))
		return `diff omitted: the worktree changed more than ${MAX_DEBUG_PATCH_BYTES} bytes against HEAD; inspect the checkout before it is removed\n`;
	const tracked = gitNullSeparated(worktree, [
		"diff",
		"HEAD",
		"--name-only",
		"-z",
	]);
	let diff = tracked.length ? gitText(worktree, ["diff", "HEAD"]) : "";
	for (const file of untracked) diff += gitDiffNoIndex(worktree, file);
	if (!diff.trim()) return undefined;
	if (Buffer.byteLength(diff) > MAX_DEBUG_PATCH_BYTES)
		return `${diff.slice(0, MAX_DEBUG_PATCH_BYTES)}\n\n[patch truncated at ${MAX_DEBUG_PATCH_BYTES} bytes]\n`;
	return diff;
}

/** Whether the changed content is already past the patch bound, measured from
 * file sizes and blob sizes — never from the diff body — so a single huge line
 * is refused before `git diff` materializes it. A tracked modification counts
 * **both** sides (its worktree size plus the `HEAD` blob it replaced), because
 * the diff can emit both; a deletion counts the blob it removed; an untracked
 * file counts its worktree size. */
function debugChangedContentAboveBound(
	worktree: string,
	untracked: readonly string[],
): boolean {
	const tracked = gitNullSeparated(worktree, [
		"diff",
		"HEAD",
		"--name-only",
		"-z",
	]);
	const headSizes = headBlobBytes(worktree, tracked);
	let total = 0;
	for (const file of new Set([...tracked, ...untracked])) {
		total += worktreeFileBytes(worktree, file) + (headSizes.get(file) ?? 0);
		if (total > MAX_DEBUG_PATCH_BYTES) return true;
	}
	return false;
}

/** The current size of one worktree file, or `0` when it is absent (a
 * deletion). */
function worktreeFileBytes(worktree: string, file: string): number {
	try {
		return fs.statSync(path.join(worktree, file)).size;
	} catch {
		return 0;
	}
}

/** The `HEAD` blob size of each named path, resolved in **one** `git cat-file
 * --batch-check` rather than one spawn per file. A path absent from `HEAD` (a
 * new untracked file) contributes nothing. */
function headBlobBytes(
	worktree: string,
	paths: readonly string[],
): Map<string, number> {
	const sizes = new Map<string, number>();
	if (!paths.length) return sizes;
	const result = Bun.spawnSync(
		["git", "-C", worktree, "cat-file", "--batch-check"],
		{
			stdin: Buffer.from(`${paths.map((file) => `HEAD:${file}`).join("\n")}\n`),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (result.exitCode !== 0) return sizes;
	const lines = result.stdout.toString().split("\n");
	paths.forEach((file, index) => {
		const parts = (lines[index] ?? "").trim().split(" ");
		if (parts.length < 3 || parts[1] === "missing") return;
		const size = Number(parts[2]);
		if (Number.isFinite(size)) sizes.set(file, size);
	});
	return sizes;
}

/** The debug handoff's artifact content: the developer-readable markdown report
 * and, when the worktree is dirty, the patch. Nothing is written: the engine
 * commits the handoff first and only then writes {@link DebugHandoffArtifacts.files},
 * so a rejected or replayed attempt leaves no bytes and no index mutation on
 * disk. The patch is computed first, so the report is never mistaken for an
 * edit. */
export interface DebugHandoffArtifacts {
	readonly entries: readonly { kind: string; path: string; digest: string }[];
	readonly files: readonly { path: string; content: string }[];
}

export function debugHandoffArtifacts(
	snapshot: WorkflowSnapshot,
	report: string,
): DebugHandoffArtifacts {
	const directory = path.join(
		snapshot.metadata.repository,
		".herdr-workflow",
		snapshot.workflowId,
	);
	const patch = debugChangesPatch(snapshot.metadata.worktree);
	const entries: { kind: string; path: string; digest: string }[] = [];
	const files: { path: string; content: string }[] = [];
	const add = (file: string, content: string, kind: string): void => {
		const target = path.join(directory, file);
		entries.push({
			kind,
			path: target,
			digest: createHash("sha256").update(content).digest("hex"),
		});
		files.push({ path: target, content });
	};
	add("debug-report.md", `${report.trim()}\n`, "debug:report");
	if (patch) add("changes.patch", patch, "debug:changes.patch");
	return { entries, files };
}

/** Write one prepared artifact set to disk (mkdir + private write). Called by
 * the engine **after** the handoff transaction commits. */
export function writeDebugArtifactFiles(
	files: readonly { path: string; content: string }[],
): void {
	for (const file of files) {
		fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file.path, file.content, { mode: 0o600 });
	}
}

/** One staged artifact: where it will land once the handoff commits, and the
 * temp file that already holds its bytes. */
export interface StagedDebugArtifacts {
	readonly path: string;
	readonly tempPath: string;
}

/** Stage the computed artifacts beside their targets (`<target>.<runId>.tmp`)
 * **before** the handoff transaction: if staging fails the handoff fails with
 * nothing committed, and a rejected attempt only ever leaves its own temp files
 * (removed by {@link discardStagedArtifacts}), never the bytes a committed
 * entry points at. The prefix makes a stale temp from a crashed run
 * identifiable and never a valid target. */
export function stageDebugArtifactFiles(
	files: readonly { path: string; content: string }[],
	runId: string,
): StagedDebugArtifacts[] {
	return files.map((file) => {
		const tempPath = `${file.path}.${runId}.tmp`;
		fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
		fs.writeFileSync(tempPath, file.content, { mode: 0o600 });
		return { path: file.path, tempPath };
	});
}

/** Rename each staged artifact over its target. Atomic within one filesystem,
 * and effectively infallible once the bytes are already staged. */
export function commitStagedArtifacts(
	staged: readonly StagedDebugArtifacts[],
): void {
	for (const artifact of staged)
		fs.renameSync(artifact.tempPath, artifact.path);
}

/** Remove a rejected attempt's staged artifacts, leaving any committed target
 * untouched. */
export function discardStagedArtifacts(
	staged: readonly StagedDebugArtifacts[],
): void {
	for (const artifact of staged)
		try {
			fs.rmSync(artifact.tempPath, { force: true });
		} catch {
			/* best-effort cleanup of a rejected attempt's temp file */
		}
}

/** Compute and write the debug family's handoff artifacts into the
 * **repository's** own data directory — not the detached worktree's, which
 * `workspace.cleanup` removes on close — and return the evidence entries the
 * reducer records. Kept as one call for callers that write eagerly (tests and
 * any synchronous path); the engine stages and then renames after the commit. */
export function writeDebugArtifacts(
	snapshot: WorkflowSnapshot,
	report: string,
): { kind: string; path: string; digest: string }[] {
	const { entries, files } = debugHandoffArtifacts(snapshot, report);
	writeDebugArtifactFiles(files);
	return [...entries];
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
	// Ignored paths are generated/local artifacts (for example `dist/`), not
	// source evidence. They may exceed the bounded file observation limit.
	const tracked = [
		...gitNullSeparated(repository, ["ls-files", "-z", "--cached"]),
		...gitNullSeparated(repository, [
			"ls-files",
			"-z",
			"--others",
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
	// Pinned root is passed explicitly to every wiki read; no process-wide
	// environment mutation (migrate-workflow-execution-to-effect, task 3.3).
	const all = snapshotList(
		// The wiki snapshot keys on the recorded change when one exists
		// (openspec workflows) and on the workflow id otherwise (wiki-only
		// and research workflows have no planner to record a change).
		snapshot.metadata.changeId || snapshot.workflowId,
		snapshot.definition.id === "wiki-comments" ||
			snapshot.definition.id === "research" ||
			snapshot.definition.id === "stage-test"
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
					.update(fs.readFileSync(conceptPath(id, pinnedRoot)))
					.digest("hex"),
			})),
	};
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
/** Whether a ref resolves in `repository`; a start guard's own bounded git
 * read, mirroring `validateStartEvidence`'s direct `git` invocation (this
 * module is the runtime boundary and does not import the CLI's wrapper). */
function resolves(repository: string, ref: string): boolean {
	const result = Bun.spawnSync(
		["git", "-C", repository, "rev-parse", "--verify", ref],
		{ stdout: "pipe", stderr: "pipe" },
	);
	return result.exitCode === 0;
}

export function validateStartEvidence(
	repository: string,
	input: StartWorkflowInput,
	definition: { id: string; policy?: WorkflowManifestPolicy },
): void {
	// Every repository family property this guard enforces is read from the
	// pinned definition's effective traits (`startRequirements`) instead of a
	// definition-id branch (read-family-traits-instead-of-ids): which families
	// need a task, a clean tree, an OpenSpec project or change, a verifiable
	// base, or rebase refs. A definition that declares no traits has no
	// requirements to meet — it never reaches here from `resolveStart`, which
	// skips the wiki and research targets.
	const requirements = new Set(
		effectiveFamilyTraits(definition)?.startRequirements ?? [],
	);
	const status = Bun.spawnSync(
		// Native store/reservation artifacts are application state, not user changes.
		// Reservation must not make its own later activation fail the clean-tree guard.
		[
			"git",
			"-C",
			repository,
			"status",
			"--porcelain",
			"--",
			".",
			":(exclude).herdr-workflow",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (status.exitCode !== 0)
		throw new WorkflowRuntimeError(
			"start-guard",
			"unable to inspect Git worktree",
		);
	if (
		status.stdout.toString().trim() &&
		requirements.has("clean-tree") &&
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
	if (requirements.has("task")) {
		if (!input.metadata.task?.trim())
			throw new WorkflowRuntimeError(
				"start-guard",
				`${input.definitionId} requires non-empty task`,
			);
		return;
	}
	// A verify-only run inspects the current checkout, so it needs no task and no
	// OpenSpec project. Its registry policy requires the repository checkout and
	// the current branch (checked above), and it declares no `clean-tree`
	// requirement, so the clean-tree rule above is deliberately skipped:
	// verifying uncommitted work is the point. What it does need is a baseline —
	// the branch's change set is `metadata.baseCommit..HEAD`, so both the base ref
	// it came from and the commit itself must resolve.
	if (requirements.has("base-commit")) {
		const base = input.metadata.baseBranch;
		if (!base)
			throw new WorkflowRuntimeError(
				"start-guard",
				"verify requires a base branch; set workflow.base_branch",
			);
		if (!resolves(repository, `${base}^{commit}`))
			throw new WorkflowRuntimeError(
				"start-guard",
				`verify base branch does not resolve: ${base}`,
			);
		if (!resolves(repository, input.metadata.baseCommit))
			throw new WorkflowRuntimeError(
				"start-guard",
				`verify base commit does not resolve: ${input.metadata.baseCommit}`,
			);
		return;
	}
	// A rebase runs one agent on a selected branch, so it needs no task and no
	// OpenSpec project — but both refs it names must exist. The registry policy
	// keeps `checkoutRequired` false (the selected branch is not necessarily the
	// checked-out one), so this guard is what refuses a start whose source branch
	// or target ref is not there. Each ref gets one direct git read, mirroring
	// the clean-tree read above; the target is checked after the start boundary's
	// best-effort fetch.
	if (requirements.has("rebase-refs")) {
		const source = input.metadata.branch;
		const target = input.metadata.baseBranch;
		if (!source || !target)
			throw new WorkflowRuntimeError(
				"start-guard",
				"rebase requires a source branch and a target branch",
			);
		if (source === target)
			throw new WorkflowRuntimeError(
				"start-guard",
				`rebase source and target are the same ref: ${source}`,
			);
		if (!resolves(repository, `refs/heads/${source}`))
			throw new WorkflowRuntimeError(
				"start-guard",
				`rebase source branch does not exist: ${source}`,
			);
		if (!resolves(repository, `${target}^{commit}`))
			throw new WorkflowRuntimeError(
				"start-guard",
				`rebase target branch does not resolve: ${target}`,
			);
		return;
	}
	if (
		requirements.has("openspec-project") &&
		!fs.existsSync(path.join(repository, "openspec", "config.yaml"))
	)
		throw new WorkflowRuntimeError("start-guard", "OpenSpec project required");
	if (requirements.has("openspec-change")) {
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
