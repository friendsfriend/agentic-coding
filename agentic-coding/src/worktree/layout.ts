// Workflow worktree root and per-repository identifier (worktree layout).
//
// The workflow layer used to pass no layout to the port, so worktrunk fell back
// to its own two-level default (`<parent>/<repo>.<branch>`). That only coincides
// with the shared `<root>/<ident>/<ident>.<branch>` layout while the repository
// is itself a container (`$DEVENV_HOME/<ident>/<ident>`); for a custom path —
// Home's New workflow entry — there is no container, the worktree landed next to
// the user's directory, and the result depended on worktrunk's ambient/project
// config. This module gives the workflow layer its own root and a stable ident,
// so `ensure` always receives an explicit location and `template.ts` stays the
// only place the path string is computed.
//
// The root is a process-level default (`<DEVENV_HOME>/worktrees`); it is a
// separate subdirectory so it can never collide with an `<ident>/` project
// container. A managed project keeps its bare directory name (its ident is
// globally unique in the environment catalog); an arbitrary path gets a short
// content hash, so two repositories that share a directory name never share a
// container.
import path from "node:path";
import { resolveDevenvHome } from "../backend/home.ts";
import type { WorktreeLocation } from "./port.ts";

/** The workflow layer's worktree root: `<DEVENV_HOME>/worktrees`.
 *
 * ponytail: process-level default, not a config key — add `workflow.worktree_root`
 * when a project needs its worktrees on a different volume. */
export function workflowWorktreeRoot(homeDir = resolveDevenvHome()): string {
	return path.join(path.resolve(homeDir), "worktrees");
}

/** The `ensure` layout input for one repository: the workflow root plus the
 * repository's directory name (managed) or that name with a short hash of the
 * canonical path (custom), so a custom repository can never claim a managed
 * project's container. */
export function workflowWorktreeLocation(
	repository: string,
	homeDir = resolveDevenvHome(),
): WorktreeLocation {
	const home = path.resolve(homeDir);
	const ident = path.basename(repository);
	const parent = path.dirname(repository);
	const managed =
		path.dirname(parent) === home && path.basename(parent) === ident;
	return {
		root: workflowWorktreeRoot(home),
		ident: managed ? ident : `${ident}-${shortHash(repository)}`,
	};
}

/** FNV-1a (32-bit) as 8 lowercase hex characters: dependency-free, stable
 * across processes, and only used to disambiguate same-named repositories. */
function shortHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
