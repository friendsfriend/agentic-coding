// Evidence storage layout and lifecycle for one workflow
// (add-workflow-evidence-store).
//
// Evidence is durable, captioned material a run produced — a screenshot, a
// video, a trace, a repro script, a log — so it must outlive the agent turn
// that wrote it and stay readable by the developer afterwards. It therefore
// lives inside the workflow's *own* data directory rather than in the agent's
// scratch space: `<workflow data root>/evidence/<workflowId>/`. For a
// repository-backed workflow the data root is the checkout's own
// `.herdr-workflow` (where its telemetry and run files already live); for a
// wiki/research workflow, which owns no worktree, it is the shared workflow
// data root.
//
// This module is the one owner of that derivation, so the store, the server
// routes, the dashboard observation and the engine's `workspace.cleanup` can
// never disagree about where a workflow's evidence is.
import fs from "node:fs";
import path from "node:path";
import { effectiveManifestPolicy } from "../definitions.ts";
import { validateWorkflowId, wikiWorkflowDataRoot } from "./targets.ts";

/** The identity a workflow's evidence location is derived from. Every field
 * comes from the workflow's own state, never from a request path. */
export interface WorkflowEvidenceLocation {
	readonly workflowId: string;
	/** The workflow's checkout. Empty for a workflow that owns none. */
	readonly worktree?: string;
	/** The workflow's definition id, which decides whether its data lives in
	 * its checkout or in the shared wiki/research data root. */
	readonly definitionId?: string;
}

/** Everything one workflow's evidence store is addressed by. `root` is the
 * directory holding `manifest.json` and the evidence files. */
export interface WorkflowEvidenceScope {
	readonly workflowId: string;
	/** The directory this workflow's own run data lives in. */
	readonly dataRoot: string;
	/** `<dataRoot>/evidence/<workflowId>`. */
	readonly root: string;
	/** The directories an agent-attached file must resolve inside. */
	readonly attachRoots: readonly string[];
}

/** The directory one debug request's evidence lives under: the request id is
 * a file-name component of the manifest's `file` field, so a reader can name
 * the request from the stored file alone (see `evidenceRequestIdOf`). */
export const EVIDENCE_REQUEST_PREFIX = "req-";

/** The debug request one stored evidence file belongs to, when it belongs to
 * one. The inverse of the prefix above, read from the manifest's file name —
 * the only place a request id is recorded. */
export function evidenceRequestIdOf(file: string): string | undefined {
	const separator = file.indexOf("/");
	if (separator <= 0) return undefined;
	const directory = file.slice(0, separator);
	if (!directory.startsWith(EVIDENCE_REQUEST_PREFIX)) return undefined;
	const requestId = directory.slice(EVIDENCE_REQUEST_PREFIX.length);
	return requestId === "" ? undefined : requestId;
}

/** The directory holding one workflow's run-scoped data: its checkout's
 * `.herdr-workflow`, or the shared wiki/research data root for a workflow that
 * targets no repository. */
export function workflowDataRoot(location: WorkflowEvidenceLocation): string {
	const worktree = (location.worktree ?? "").trim();
	let repositoryBacked = true;
	try {
		repositoryBacked =
			effectiveManifestPolicy({ id: location.definitionId ?? "" })
				.targetKind === "repository";
	} catch {
		// A custom or removed definition has no policy row. Its rows were read
		// from a repository store, so that is where its data stays.
		repositoryBacked = true;
	}
	if (!repositoryBacked || worktree === "") return wikiWorkflowDataRoot();
	return path.join(worktree, ".herdr-workflow");
}

/** The evidence directory of one workflow: `<dataRoot>/evidence/<workflowId>`.
 * The workflow id is validated here because it is a path component. */
export function workflowEvidenceRoot(
	location: WorkflowEvidenceLocation,
): string {
	const workflowId = validateWorkflowId(location.workflowId);
	return path.join(workflowDataRoot(location), "evidence", workflowId);
}

/**
 * The roots an agent-attached source file may resolve inside: the workflow's
 * checkout, and the workflow's own data directory (which holds the scratch
 * space a run is given). Both are real paths the server derives from the
 * workflow's state; neither is ever a value the caller supplied.
 */
export function workflowAttachRoots(
	location: WorkflowEvidenceLocation,
): string[] {
	const roots: string[] = [];
	const worktree = (location.worktree ?? "").trim();
	if (worktree !== "") roots.push(path.resolve(worktree));
	const dataRoot = workflowDataRoot(location);
	if (!roots.includes(dataRoot)) roots.push(dataRoot);
	return roots;
}

/** One workflow's evidence scope, or a refusal when its id is not a usable
 * directory component. */
export function workflowEvidenceScope(
	location: WorkflowEvidenceLocation,
): WorkflowEvidenceScope {
	const workflowId = validateWorkflowId(location.workflowId);
	return {
		workflowId,
		dataRoot: workflowDataRoot(location),
		root: workflowEvidenceRoot(location),
		attachRoots: workflowAttachRoots(location),
	};
}

/** Whether one component of a manifest `file` is a plain name the store may
 * use: non-empty, not `.` or `..`, and free of a backslash that separates a
 * path elsewhere. The one owner of the rule: the store's own reader applies it
 * to a manifest it reads, and the dashboard applies it to a `file` a server
 * sent before composing a local path from it. */
export function isPlainEvidenceName(component: string): boolean {
	return (
		component !== "" &&
		component !== "." &&
		component !== ".." &&
		!component.includes("\\")
	);
}

/** One evidence file's absolute path inside the evidence root: the one place
 * the address (`<root>/<relative name>`) is composed, so the store, the file
 * route and the dashboard's opener can never disagree about it. */
export function evidenceFileAt(root: string, file: string): string {
	return path.join(root, file);
}

/**
 * One manifest entry's absolute path, composed from the workflow's own evidence
 * root — or `undefined` when the recorded name is not the shape the store
 * writes (`[req-<requestId>/]<id>.<ext>`, at most two plain components) or would
 * leave that root.
 *
 * The store's own reader applies the same rule to a manifest it trusts; this is
 * the check for a name a *server* sent, which is untrusted here.
 */
export function workflowEvidenceFilePath(
	location: WorkflowEvidenceLocation,
	file: string,
): string | undefined {
	const components = file.split("/");
	if (components.length > 2) return undefined;
	if (!components.every(isPlainEvidenceName)) return undefined;
	const root = workflowEvidenceRoot(location);
	const candidate = evidenceFileAt(root, file);
	const inside =
		candidate === root || candidate.startsWith(`${root}${path.sep}`);
	return inside ? candidate : undefined;
}

// One writer at a time per evidence root. The lock is in-process because the
// store is only reached through the one server process, and it covers *every*
// writer of that root — the attaches and the workflow's own deletion — because
// an attach that ran after a delete would recreate the directory that delete
// removed, leaving evidence for a workflow no store knows about.
const rootLocks = new Map<string, Promise<void>>();

/** Serialise every write against one workflow's evidence root. */
export function withEvidenceRootLock<T>(
	root: string,
	run: () => T | Promise<T>,
): Promise<T> {
	const previous = rootLocks.get(root) ?? Promise.resolve();
	const result = previous.then(run, run);
	const chained = result.then(
		() => undefined,
		() => undefined,
	);
	rootLocks.set(root, chained);
	void chained.then(() => {
		if (rootLocks.get(root) === chained) rootLocks.delete(root);
	});
	return result;
}

/** Whether the workflow's evidence directory is present. A symlink is not
 * evidence: it is never treated as a directory this module would delete. */
export function workflowEvidencePresent(
	location: WorkflowEvidenceLocation,
): boolean {
	let root: string;
	try {
		root = workflowEvidenceRoot(location);
	} catch {
		return false;
	}
	try {
		const stat = fs.lstatSync(root);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Delete one workflow's evidence directory. Idempotent — an absent directory is
 * already clean — and never follows a symlink out of the data root: a root that
 * is a symlink, or not a directory at all, is left alone. Answers whether a
 * directory was removed.
 *
 * Runs under the root's write lock, so a deletion that races an attach either
 * removes everything that attach wrote or runs after it — never before it, which
 * is how an attach used to resurrect a deleted workflow's evidence.
 */
export async function removeWorkflowEvidence(
	location: WorkflowEvidenceLocation,
): Promise<boolean> {
	let root: string;
	try {
		root = workflowEvidenceRoot(location);
	} catch {
		return false;
	}
	return await withEvidenceRootLock(root, () => {
		try {
			const stat = fs.lstatSync(root);
			if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
		} catch {
			return false;
		}
		try {
			fs.rmSync(root, { recursive: true, force: true });
			return true;
		} catch {
			// A directory that cannot be removed (permissions, a busy file) leaves the
			// workflow's other cleanup work untouched; the deletion is reported by the
			// caller's own result rather than thrown from here.
			return false;
		}
	});
}
