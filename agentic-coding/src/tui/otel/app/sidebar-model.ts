// Workspace sidebar projection (integrated-multiplexer sidebar).
//
// Pure list/geometry logic for the shell's workspace sidebar: which durable
// workflows a filter shows, how one row is labelled, the status glyph, and the
// panel directions the sidebar sits on. No renderer, no gateway, no Effect
// wrapper — the component and the shell key layer read these functions, and a
// unit test can pin them without a terminal.
import type { WorkflowOverview } from "../../../contracts/workflow.ts";

/** Which workflows the sidebar lists. `active` is the default filter. */
export type SidebarFilter = "active" | "attention" | "all";

export const SIDEBAR_FILTERS: readonly {
	id: SidebarFilter;
	label: string;
}[] = [
	{ id: "active", label: "Active" },
	{ id: "attention", label: "Attention" },
	{ id: "all", label: "All" },
];

export const DEFAULT_SIDEBAR_FILTER: SidebarFilter = "active";

/** Running statuses: what "running workspaces" means for the default filter. */
export function isRunningStatus(status: string): boolean {
	return (
		status === "active" ||
		status === "paused" ||
		status === "attention-required"
	);
}

export function matchesSidebarFilter(
	overview: WorkflowOverview,
	filter: SidebarFilter,
): boolean {
	switch (filter) {
		case "active":
			return isRunningStatus(overview.state.status);
		case "attention":
			return overview.state.status === "attention-required";
		case "all":
			return true;
	}
}

/** Newest workflow first by creation time, with a stable id tiebreak. The key
 * is immutable for the workflow's whole life, so advancing a phase cannot
 * reorder the list under the reader. */
export function sortOverviews(
	overviews: readonly WorkflowOverview[],
): WorkflowOverview[] {
	const stamp = (overview: WorkflowOverview): string =>
		overview.state.createdAt ?? overview.state.workflowId;
	return [...overviews].sort((a, b) => {
		const left = stamp(a);
		const right = stamp(b);
		if (left !== right) return left < right ? 1 : -1;
		return a.state.workflowId.localeCompare(b.state.workflowId);
	});
}

export function filterOverviews(
	overviews: readonly WorkflowOverview[],
	filter: SidebarFilter,
): WorkflowOverview[] {
	return sortOverviews(
		overviews.filter((overview) => matchesSidebarFilter(overview, filter)),
	);
}

/** The pinned entry the sidebar keeps above every workflow row. It is not a
 * workflow: it has no overview, no status and no filter, so the poll, the
 * cursor reveal and the delete/spawn actions never see it. The shell pins it
 * while it renders the Orchestrator surface (home mode), whatever the workflow
 * list and its filter happen to hold. */
export interface SidebarPin {
	/** Row mark; the same Home glyph an orchestrator-started workflow carries. */
	readonly glyph: string;
	readonly label: string;
	/** Second line, in the slot a workflow row uses for its phase and project. */
	readonly meta: string;
}

export const SIDEBAR_ORCHESTRATOR_PIN: SidebarPin = {
	glyph: "⌂",
	label: "Orchestrator",
	meta: "chat · launch · manage",
};

/** Cursor positions the sidebar offers: the pinned entry first (when it is
 * pinned), then the filter's workflow rows. */
export function sidebarCursorCount(rowCount: number, pinned: boolean): number {
	return Math.max(0, rowCount) + (pinned ? 1 : 0);
}

/** The workflow row a cursor position names, or -1 while the cursor sits on the
 * pinned leading entry. The inverse of `sidebarCursorForWorkflow`. */
export function sidebarWorkflowIndex(cursor: number, pinned: boolean): number {
	return pinned ? cursor - 1 : cursor;
}

/** The cursor position that selects a workflow row, so revealing the open
 * workflow keeps the pinned entry's leading slot. */
export function sidebarCursorForWorkflow(
	index: number,
	pinned: boolean,
): number {
	return pinned ? index + 1 : index;
}

/** Next filter in catalog order, wrapping at the end. */
export function cycleFilter(filter: SidebarFilter): SidebarFilter {
	const index = SIDEBAR_FILTERS.findIndex((entry) => entry.id === filter);
	return SIDEBAR_FILTERS[(index + 1) % SIDEBAR_FILTERS.length].id;
}

/**
 * Next cursor position in a wrapped walk over the sidebar's entries — the
 * workspace cycle (`Ctrl+H`/`Ctrl+L`). An empty cursor space has nowhere to go,
 * and a position left outside the space (the filter or a poll shrank the list
 * under the cursor) clamps into it before stepping, so a cycle can never move
 * the cursor out of range.
 */
export function cycleCursor(
	index: number,
	count: number,
	delta: number,
): number {
	if (count <= 0) return 0;
	const from = Math.min(Math.max(index, 0), count - 1);
	return (((from + delta) % count) + count) % count;
}

export function filterLabel(filter: SidebarFilter): string {
	return SIDEBAR_FILTERS.find((entry) => entry.id === filter)?.label ?? filter;
}

/** Semantic colour token for a workflow status; the renderer maps it to a
 * theme colour so the model stays free of renderer imports. */
export type StatusTone = "success" | "warning" | "error" | "info" | "muted";

/** Step ids whose work is a review/approval someone reads before the workflow
 * moves on (the developer-review gate, plan/wiki approvals, the verifier gate,
 * the verification step itself). */
export function isReviewStep(stepId: string | undefined): boolean {
	if (!stepId) return false;
	if (stepId === "core.verification") return true;
	return /(review|approval)/.test(stepId) || /-gate$/.test(stepId);
}

/** The row glyph and tone: a developer question (`?`), a blocker (`!`), a
 * review step (`✓`), a running workflow (`…`), idle (`◦`), and the terminal
 * states. `attention` is deliberately not a blocker: entries there are
 * diagnostic notes (a skipped stage gate, a classifier that failed open)
 * appended while the workflow keeps running, so they must not light the input
 * marker. Only committed evidence of intervention — a question, an invalid
 * workflow, or the `attention-required` status — reads as `!`. */
export function sidebarStatusGlyph(overview: WorkflowOverview): {
	glyph: string;
	tone: StatusTone;
} {
	const state = overview.state;
	// A pending developer question is a blocker with a specific answer path, so
	// it gets its own glyph before the generic `!`.
	if ((state.pendingQuestions?.length ?? 0) > 0)
		return { glyph: "?", tone: "warning" };
	if (!state.health.valid) return { glyph: "!", tone: "error" };
	// A committed attention-required status outranks the review-step check: a
	// workflow blocked at a review/approval gate still needs a reader.
	if (state.status === "attention-required")
		return { glyph: "!", tone: "warning" };
	if (isReviewStep(state.stepId ?? state.phase))
		return { glyph: "✓", tone: "info" };
	switch (state.status) {
		case "active":
			return { glyph: "…", tone: "info" };
		case "paused":
			return { glyph: "◦", tone: "muted" };
		case "completed":
			return { glyph: "✓", tone: "success" };
		case "closed":
			return { glyph: "·", tone: "muted" };
		default:
			return { glyph: "·", tone: "muted" };
	}
}

/** The workflow's display name: the id the dashboard is addressed by. */
export function workflowDisplayName(overview: WorkflowOverview): string {
	return overview.state.workflowId;
}

/** True when the Home Orchestrator started this workflow rather than the
 * operator. A workflow without the attribution reads as developer-started, so
 * nothing is marked that was not recorded. */
export function isOrchestratorStarted(overview: WorkflowOverview): boolean {
	return overview.startedBy === "orchestrator";
}

/** True when the row's pinned definition is a stored custom one (composed for
 * that request rather than shipped in the code registry). The view reports the
 * origin; a row written before the projection existed reads as built-in. */
export function isCustomDefinition(overview: WorkflowOverview): boolean {
	return overview.state.definitionOrigin?.kind === "custom";
}

/** The row's name line: the workflow id, prefixed by the Home badge when the
 * orchestrator started it and by the custom-shape glyph when its definition is
 * custom. Both marks are glyphs, so a marked row still fits the sidebar width
 * (the renderer clips the line, and text would cost it characters). The marker
 * is data here; colours and separators stay with the renderer. */
export function workflowRowLabel(overview: WorkflowOverview): string {
	const marks = [
		isOrchestratorStarted(overview) ? "⌂" : "",
		isCustomDefinition(overview) ? "◊" : "",
	].filter(Boolean);
	const name = workflowDisplayName(overview);
	return marks.length ? `${marks.join(" ")} ${name}` : name;
}

/** Index of the sidebar row for the workflow the page body is showing, or -1
 * when the current list/filter does not hold it. Used to reveal the open
 * workflow when the sidebar takes focus. */
export function sidebarIndexFor(
	overviews: readonly WorkflowOverview[],
	open: { readonly repo: string; readonly workflowId: string } | undefined,
): number {
	if (!open) return -1;
	return overviews.findIndex(
		(row) =>
			row.state.workflowId === open.workflowId && row.target === open.repo,
	);
}

/** Second line: phase and the project/repository the workflow runs against. */
export function workflowMeta(overview: WorkflowOverview): string {
	const phase = overview.state.stepLabel ?? overview.state.phase;
	const project = overview.projectIdent ?? overview.state.repository;
	return `${phase} · ${project}`;
}

/** Clip one string to `max` cells with an ellipsis, never exceeding `max`. */
export function clip(value: string, max: number): string {
	if (max <= 0) return "";
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** How the sidebar sizes itself: `expanding` collapses it to the workspace
 * index while unfocused and expands it on focus; `permanent` keeps it expanded
 * at all times. */
export type SidebarMode = "expanding" | "permanent";

/** The mode one toggle key press selects. */
export function toggleSidebarMode(mode: SidebarMode): SidebarMode {
	return mode === "permanent" ? "expanding" : "permanent";
}
