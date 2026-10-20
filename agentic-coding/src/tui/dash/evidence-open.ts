// Opening one evidence file (add-dashboard-evidence-panel, tasks 2.3/3.1).
//
// `Enter` and `y` act on the *stored* file the manifest names, so its address is
// composed by the evidence store's own module (`workflowEvidenceFilePath`)
// rather than re-derived here: the dashboard and the store can never disagree
// about where a workflow's evidence lives, and the store's own name rule (at
// most two plain components, inside the evidence root) is applied to the
// server-supplied name before anything is launched. The launch itself is a side
// app — a tmux window inside tmux, a local spawn otherwise
// (`src/tui/shared/side-app.ts`).
import fs from "node:fs";
import type { EvidenceEntry } from "../../contracts/environment.ts";
import type { WorkflowState } from "../../contracts/workflow.ts";
import { workflowEvidenceFilePath } from "../../workflow/runtime/evidence-store.ts";
import {
	runSideApp,
	type SideAppOutcome,
	type SideAppRequest,
	systemOpenerSideApp,
} from "../shared/side-app.ts";

/** The workflow state the evidence address is derived from: the store locates a
 * workflow by its id, checkout and definition, exactly like the server does. */
export type EvidenceLocationState = Pick<
	WorkflowState,
	"workflowId" | "worktree" | "definition"
>;

/** One recorded evidence file is not addressable on this machine: the name is
 * not the shape the store writes (or would leave the workflow's evidence root),
 * the file is not there, or it is not a regular file. */
export class EvidencePathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvidencePathError";
	}
}

/** The absolute path of one entry's file on the machine this dashboard runs on.
 * A name the store would not have written is refused rather than composed into
 * a path outside the evidence root. A dashboard attached to a server on another
 * machine still composes the path that server would use; `openEvidenceExternally`
 * reports that it is not here. */
export function evidenceLocalPath(
	state: EvidenceLocationState,
	entry: EvidenceEntry,
): string {
	const file = workflowEvidenceFilePath(
		{
			workflowId: state.workflowId,
			worktree: state.worktree,
			...(state.definition ? { definitionId: state.definition.id } : {}),
		},
		entry.file,
	);
	if (!file)
		throw new EvidencePathError(
			`${JSON.stringify(entry.file)} is not a path inside this workflow's evidence`,
		);
	return file;
}

/** The launch one entry's file needs: the platform's system opener, pointed at
 * the stored file. Pure, so the composed request is testable per platform. */
export function evidenceOpenRequest(
	state: EvidenceLocationState,
	entry: EvidenceEntry,
): SideAppRequest {
	return systemOpenerSideApp(evidenceLocalPath(state, entry));
}

/**
 * Open one evidence file with the platform's system opener — for every kind,
 * including a video, whose bytes are never rendered inline.
 *
 * The check below is a *pre-flight* one: it refuses a stored file that is
 * missing, is not a regular file, or has been replaced by a symlink when it
 * runs. A run with write access to its own evidence directory could still swap
 * the name between that check and the opener's own `open(2)`, because the
 * launcher takes a name rather than a descriptor; the window is narrow, not
 * closed, and it is bounded by that run sharing this process's uid (it can
 * already act as the developer). An opener that starts and exits non-zero is
 * reported instead of swallowed. Never swallows a failure: the caller reports it
 * as a toast.
 */
export async function openEvidenceExternally(
	state: EvidenceLocationState,
	entry: EvidenceEntry,
	open: (request: SideAppRequest) => Promise<SideAppOutcome> = runSideApp,
): Promise<void> {
	const file = evidenceLocalPath(state, entry);
	let stat: fs.Stats;
	try {
		// `lstat`, so a symlink swapped in for the stored file is refused rather
		// than handed to an opener that would follow it.
		stat = fs.lstatSync(file);
	} catch {
		throw new EvidencePathError(`${file} is not on this machine`);
	}
	if (!stat.isFile())
		throw new EvidencePathError(`${file} is not a regular file`);
	const outcome = await open(evidenceOpenRequest(state, entry));
	// A non-zero status is reported: the local opener's own exit, or a tmux window
	// request that could not be served at all.
	if (outcome.status !== undefined && outcome.status !== 0)
		throw new EvidencePathError(
			`${file}: ${outcome.stderr?.trim() || `the opener exited ${outcome.status}`}`,
		);
}

/** The absolute path of one workflow's flow page, composed by the same store
 * module the writer uses. A workflow whose evidence root would not hold the name
 * answers `undefined` rather than a path outside it. */
export function stageFlowPath(
	state: EvidenceLocationState,
	flowPage: string,
): string | undefined {
	return (
		workflowEvidenceFilePath(
			{
				workflowId: state.workflowId,
				worktree: state.worktree,
				...(state.definition ? { definitionId: state.definition.id } : {}),
			},
			flowPage,
		) ?? undefined
	);
}

/**
 * Open `stage-flow.html` with the platform's system opener — the Evidence
 * panel's "open flow" action.
 *
 * Note that the journal may name no page at all (`flowPage` absent), which is
 * the caller's business to report; a named page that is not on this machine, is
 * not a regular file, or was replaced by a symlink is refused here rather than
 * handed to an opener.
 */
export async function openStageFlowExternally(
	state: EvidenceLocationState,
	flowPage: string,
	open: (request: SideAppRequest) => Promise<SideAppOutcome> = runSideApp,
): Promise<void> {
	const file = stageFlowPath(state, flowPage);
	if (file === undefined)
		throw new EvidencePathError(
			`${JSON.stringify(flowPage)} is not a path inside this workflow's evidence`,
		);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(file);
	} catch {
		throw new EvidencePathError(`${file} is not on this machine`);
	}
	if (!stat.isFile())
		throw new EvidencePathError(`${file} is not a regular file`);
	const outcome = await open(systemOpenerSideApp(file));
	if (outcome.status !== undefined && outcome.status !== 0)
		throw new EvidencePathError(
			`${file}: ${outcome.stderr?.trim() || `the opener exited ${outcome.status}`}`,
		);
}
