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

/** Most recently touched workflow first, with a stable id tiebreak so the list
 * cannot reorder between two polls that read the same state. */
export function sortOverviews(
	overviews: readonly WorkflowOverview[],
): WorkflowOverview[] {
	const stamp = (overview: WorkflowOverview): string =>
		overview.state.phaseStartedAt ??
		overview.state.createdAt ??
		overview.state.workflowId;
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

/** Next filter in catalog order, wrapping at the end. */
export function cycleFilter(filter: SidebarFilter): SidebarFilter {
	const index = SIDEBAR_FILTERS.findIndex((entry) => entry.id === filter);
	return SIDEBAR_FILTERS[(index + 1) % SIDEBAR_FILTERS.length].id;
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
 * states. The overview is read rather than the bare status because a question
 * and a blocker are the interesting states of an otherwise active workflow. */
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
	if (state.health.attention.length > 0) return { glyph: "!", tone: "warning" };
	if (isReviewStep(state.stepId ?? state.phase))
		return { glyph: "✓", tone: "info" };
	switch (state.status) {
		case "active":
			return { glyph: "…", tone: "info" };
		case "attention-required":
			return { glyph: "!", tone: "warning" };
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
