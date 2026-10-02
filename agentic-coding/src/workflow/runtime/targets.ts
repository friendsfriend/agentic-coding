// Workflow target identity: change-id validation, the repository-independent
// wiki/research target locators, and canonical repository/store path
// resolution. Zero-dependency foundation used by nearly every other runtime
// module. Moved verbatim out of runtime.ts (split-workflow-god-modules).
import fs from "node:fs";
import path from "node:path";
import { WorkflowRuntimeError } from "../contracts.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	openSecureFile,
} from "../secure-fs.ts";
import { wikiRoot } from "../wiki.ts";

const WORKFLOW_ID = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** User-supplied workflow identifier: the string a workflow is started and
 * addressed with. Shares the change-id shape so both can serve as branch
 * seeds and directory-name components interchangeably. */
export function validateWorkflowId(value: string): string {
	if (!WORKFLOW_ID.test(value))
		throw new WorkflowRuntimeError(
			"workflow-id",
			"workflow id must be 1-80 lowercase letters, digits, or hyphens",
		);
	return value;
}

/** Planner-derived change identifier (declared as the primary change at plan
 * handoff; also used to bound legacy/open-spec directory names). */
export function validateChangeId(value: string): string {
	if (!WORKFLOW_ID.test(value))
		throw new WorkflowRuntimeError(
			"change-id",
			"change ID must be 1-80 lowercase letters, digits, or hyphens",
		);
	return value;
}

/** A repository's canonical root is a pure function of its resolved path *and
 * the directory that path currently names*, but deriving it spawns a `git
 * rev-parse` child. The workflow runtime derives paths several times per
 * operation (store open, path verification, view projection), so the child
 * dominated hot paths — measured at ~66 spawns per engine-heavy test.
 *
 * The answer is *not* pure in the path alone: a worktree path can be removed and
 * recreated from a different main repository, or promoted from a plain clone to a
 * linked worktree, and the cached root would then point an operation at another
 * repository's store — a silently wrong destination rather than an error, since
 * `verifyCanonicalStorePath` compares two values that share this cache. So an
 * entry is only honoured while the directory it was derived from still has the
 * same identity, which is one `stat` against the `git` spawn the cache exists to
 * avoid.
 *
 * Failures are never cached and an entry is dropped as soon as the path stops
 * resolving, so a repository created after a failed probe is still discovered. */
interface CachedRepository {
	canonical: string;
	dev: bigint | number;
	ino: bigint | number;
	/** Directory creation time. An inode is reused after a directory is deleted,
	 * so identity needs a field that cannot be: a re-created directory cannot
	 * share both an inode and a creation time with the one it replaced. Taken
	 * from the same `stat` as the rest, so it costs nothing extra. */
	birthtimeMs: number;
}
const canonicalRepositoryCache = new Map<string, CachedRepository>();
/** Bounds the cache for long-lived processes (dashboard/server) that may see
 * many short-lived worktrees. Eviction drops the oldest entry rather than
 * clearing the map: a wholesale `clear()` at the limit would make every call
 * past it re-probe, which is exactly the long-lived case the cache is for. */
const CANONICAL_REPOSITORY_CACHE_LIMIT = 256;

function dropCanonicalRepository(resolved: string): void {
	canonicalRepositoryCache.delete(resolved);
}

export function canonicalRepository(repo: string): string {
	const resolved = fs.realpathSync(path.resolve(repo));
	const cached = canonicalRepositoryCache.get(resolved);
	if (cached !== undefined) {
		let current: fs.Stats | undefined;
		try {
			current = fs.statSync(resolved);
		} catch {
			current = undefined;
		}
		if (
			current &&
			current.dev === cached.dev &&
			current.ino === cached.ino &&
			current.birthtimeMs === cached.birthtimeMs
		)
			return cached.canonical;
		// The path now names something else (or nothing): the memo is stale.
		dropCanonicalRepository(resolved);
	}
	const result = Bun.spawnSync(
		[
			"git",
			"-C",
			resolved,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) throw new Error(`not a Git repository: ${repo}`);
	const common = fs.realpathSync(result.stdout.toString().trim());
	const canonical =
		path.basename(common) === ".git" ? path.dirname(common) : resolved;
	// The directory can be pruned between the probe and this stat — the dashboard
	// removes worktrees while it reads them — and an optimisation must degrade to
	// an uncached answer, never to a thrown ENOENT that hides the root we already
	// derived.
	let identity: fs.Stats | undefined;
	try {
		identity = fs.statSync(resolved);
	} catch {
		identity = undefined;
	}
	if (!identity) return canonical;
	if (canonicalRepositoryCache.size >= CANONICAL_REPOSITORY_CACHE_LIMIT) {
		const oldest = canonicalRepositoryCache.keys().next();
		if (!oldest.done) dropCanonicalRepository(oldest.value);
	}
	canonicalRepositoryCache.set(resolved, {
		canonical,
		dev: identity.dev,
		ino: identity.ino,
		birthtimeMs: identity.birthtimeMs,
	});
	return canonical;
}
/** Explicit locator for workflows that review the centralized wiki without a repository. */
export const WIKI_WORKFLOW_TARGET = "wiki://centralized";
export const RESEARCH_WORKFLOW_TARGET = "research://standalone";
export function wikiWorkflowTarget(): string {
	return WIKI_WORKFLOW_TARGET;
}
export function researchWorkflowTarget(): string {
	return RESEARCH_WORKFLOW_TARGET;
}
export function isWikiWorkflowTarget(repo: string): boolean {
	return repo === WIKI_WORKFLOW_TARGET;
}
export function isResearchWorkflowTarget(repo: string): boolean {
	return repo === RESEARCH_WORKFLOW_TARGET;
}
function rejectSymlinkComponents(base: string, target: string): void {
	const relative = path.relative(base, target);
	if (relative.startsWith("..") || path.isAbsolute(relative))
		throw new WorkflowRuntimeError(
			"path-security",
			"workflow store path escapes its data root",
		);
	let current = base;
	for (const component of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		try {
			if (fs.lstatSync(current).isSymbolicLink())
				throw new WorkflowRuntimeError(
					"path-security",
					`workflow store path contains a symlink: ${current}`,
				);
		} catch (error) {
			if (error instanceof WorkflowRuntimeError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export function wikiWorkflowDataRoot(): string {
	const root = fs.realpathSync(path.dirname(wikiRoot()));
	const dataRoot = path.join(root, ".agentic-coding-workflow");
	rejectSymlinkComponents(root, dataRoot);
	return dataRoot;
}
export function guardStoreFile(
	file: string,
	create: boolean,
	readonly = false,
): number {
	const parent = path.dirname(file);
	const directory = openSecureDirectory(parent, path.dirname(parent));
	try {
		const flags =
			(readonly ? fs.constants.O_RDONLY : fs.constants.O_RDWR) |
			(create ? fs.constants.O_CREAT : 0) |
			(fs.constants.O_NOFOLLOW ?? 0);
		return openSecureFile(directory, path.basename(file), flags, 0o600);
	} finally {
		closeSecureDirectory(directory);
	}
}

export function verifyCanonicalStorePath(repo: string, file: string): void {
	if (canonicalStorePath(repo) !== file || fs.realpathSync(file) !== file)
		throw new WorkflowRuntimeError(
			"path-security",
			"workflow store path changed while opening",
		);
}

export function canonicalStorePath(repo: string): string {
	if (isWikiWorkflowTarget(repo) || isResearchWorkflowTarget(repo)) {
		const root = wikiWorkflowDataRoot();
		const file = path.join(root, "herdr.db");
		rejectSymlinkComponents(root, file);
		return file;
	}
	const repository = canonicalRepository(repo);
	const root = path.join(repository, ".herdr-workflow");
	const file = path.join(root, "herdr.db");
	rejectSymlinkComponents(repository, root);
	rejectSymlinkComponents(root, file);
	return file;
}
