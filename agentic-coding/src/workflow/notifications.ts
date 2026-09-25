// Pure developer-action notification projection
// (workflow-developer-notifications).
//
// Reuses the sidebar's obligation semantics so the sidebar marker and the
// Herdr notification always agree on whether a workflow owes developer input.
// No I/O, clock, or TUI imports: the observer supplies the views, the live
// observations, and the target classification, and the sync boundary owns
// every Herdr write.
import type { WorkflowView } from "../contracts/workflow.ts";
import {
	phaseLabel,
	projectLabel,
	type SidebarTargetClassification,
	sidebarText,
	workflowRequiresInput,
} from "./sidebar.ts";

/** One notification to raise for a workflow that newly owes developer input. */
export interface DeveloperActionNotification {
	/** Stable, repository-scoped transition identity. */
	identity: string;
	/** Bare workflow id (unique only within one repository). */
	workflowId: string;
	/** Notification title: project + workflow id identity. */
	title: string;
	/** Notification body: the current phase label. */
	body: string;
}

/**
 * Repository-scoped transition key. Workflow ids are unique only per
 * repository (`canonicalStorePath` is per repo), so two governed repositories
 * can share an id; keying the transition map by the bare id would drop the
 * second workflow's notification. The separator is a NUL that cannot appear in
 * either path or id.
 */
export function workflowNotificationKey(view: WorkflowView): string {
	return `${view.repository ?? view.worktree ?? ""}\u0000${view.workflowId}`;
}

/**
 * The notification for a workflow that owes developer input, or `undefined`
 * when it owes none. `agentRequiresInput` is the live per-run obligation
 * already reduced by `paneInputFacts` (a pending developer question, a fresh
 * `blocked` observation, or a retained positive observation), exactly as the
 * sidebar projects it; the committed status/action obligation is applied here
 * through `workflowRequiresInput`. The title and body reuse the sidebar's
 * bounded single-line sanitizer so untrusted store/view text can never carry
 * terminal control sequences into the Herdr toast.
 */
export function developerActionNotification(
	view: WorkflowView,
	agentRequiresInput: boolean,
	standalone: readonly SidebarTargetClassification[] = [],
): DeveloperActionNotification | undefined {
	if (!workflowRequiresInput(view, agentRequiresInput)) return undefined;
	return {
		identity: workflowNotificationKey(view),
		workflowId: view.workflowId,
		title: sidebarText(
			`${projectLabel(view, standalone)} · ${view.workflowId}`,
		),
		body: sidebarText(phaseLabel(view)),
	};
}

/** Whether this refresh should raise a notification and the state to record. */
export interface OwedTransition {
	/** True only on a false → true transition after a known baseline. */
	notify: boolean;
	/** The obligation state to remember for the next refresh. */
	state: boolean;
}

/**
 * Transition-dedup with an initial baseline: the first observation of a
 * workflow records its state without notifying (a shell restart never replays
 * every outstanding obligation), a false → true transition notifies once, and
 * a clear followed by a new obligation notifies again.
 */
export function nextOwedState(
	previous: boolean | undefined,
	owed: boolean,
): OwedTransition {
	if (previous === undefined) return { notify: false, state: owed };
	return { notify: !previous && owed, state: owed };
}
