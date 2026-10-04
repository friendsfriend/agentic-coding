// Open a finding in the developer's editor (multiplexer removal).
//
// The path is agent-influenceable, so it is validated against the workflow
// worktree before any process starts — the same boundary the pane command
// enforced. The launch itself is a side app: a tmux window inside tmux, a local
// spawn otherwise (`src/tui/side-app.ts`).
import { isAbsolute, resolve, sep } from "node:path";
import type { WorkflowState } from "../../contracts/workflow.ts";
import { editorSideApp, openSideApp } from "../shared/side-app.ts";

/** Absolute path of one finding file inside the worktree, or a thrown error. */
export function resolveFindingPath(
	worktree: string,
	path: string | undefined,
): string {
	if (!path) throw new Error("Finding has no file path.");
	if (isAbsolute(path) || path.split(/[/]/).includes(".."))
		throw new Error("finding path must stay inside the worktree");
	const root = resolve(worktree);
	const file = resolve(root, path);
	if (file !== root && !file.startsWith(`${root}${sep}`))
		throw new Error("finding path escapes the worktree");
	return file;
}

/** Open one finding at its line. Never throws into a key handler: the caller
 * reports failures as a toast. */
export async function openFindingInEditor(
	state: WorkflowState,
	finding: { path?: string; line?: number },
): Promise<void> {
	const file = resolveFindingPath(state.worktree, finding.path);
	await openSideApp(editorSideApp(file, finding.line));
}
