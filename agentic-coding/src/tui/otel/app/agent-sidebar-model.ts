// Agent navigation sidebar projection and geometry.
//
// Pure workflow observation -> row projection: latest run per role, Active/All
// filtering, stable identity/selection reconciliation, and responsive panel
// allocation. The shell and renderer own I/O and presentation respectively.
import type {
	RunStatus,
	WorkflowOverview,
} from "../../../contracts/workflow.ts";

export type AgentSidebarFilter = "active" | "all";
export type AgentSidebarMode = "expanding" | "permanent";

export interface AgentSidebarRow {
	/** Stable across metadata/status refreshes; distinguishes the same run in
	 * different workflow stores. */
	readonly key: string;
	readonly target: string;
	readonly workflowId: string;
	readonly runId: string;
	readonly role: string;
	readonly status: RunStatus;
	readonly runtime?: string;
	readonly model?: string;
	readonly workflowStep?: string;
	readonly hostSocket?: string;
	readonly conversationId?: string;
}

const UTILITY_ROLES = new Set(["git", "dashboard"]);

/** Project only the latest recorded run for each role in each observed
 * workflow. Equal attempts use the later record, matching the dashboard's
 * latest-per-role projection. Sort by immutable workflow/role identity rather
 * than mutable status or activity so a refresh cannot reorder the selection. */
export function projectAgentSidebarRows(
	overviews: readonly WorkflowOverview[],
): AgentSidebarRow[] {
	const rows: AgentSidebarRow[] = [];
	for (const overview of overviews) {
		const latest = new Map<string, (typeof overview.state.runs)[number]>();
		for (const run of overview.state.runs) {
			if (UTILITY_ROLES.has(run.role)) continue;
			const existing = latest.get(run.role);
			if (!existing || existing.attempt <= run.attempt)
				latest.set(run.role, run);
		}
		for (const run of latest.values()) {
			rows.push({
				key: JSON.stringify([
					overview.target,
					overview.state.workflowId,
					run.id,
				]),
				target: overview.target,
				workflowId: overview.state.workflowId,
				runId: run.id,
				role: run.role,
				status: run.status,
				...(run.runtime ? { runtime: run.runtime } : {}),
				...(run.model ? { model: run.model } : {}),
				...(overview.state.stepLabel || overview.state.stepId
					? {
							workflowStep: overview.state.stepLabel ?? overview.state.stepId,
						}
					: {}),
				...(run.hostSocket ? { hostSocket: run.hostSocket } : {}),
				...(run.conversationId ? { conversationId: run.conversationId } : {}),
			});
		}
	}
	return rows.sort(compareAgentRows);
}

function compareAgentRows(a: AgentSidebarRow, b: AgentSidebarRow): number {
	return (
		a.target.localeCompare(b.target) ||
		a.workflowId.localeCompare(b.workflowId) ||
		a.role.localeCompare(b.role) ||
		a.runId.localeCompare(b.runId)
	);
}

/** Cache only the small latest-role projection, never historical run arrays.
 * Observation revisions include run/session metadata changes. Routine refreshes
 * can replace observation objects without forcing another history scan. */
export function createAgentSidebarProjector(): (
	overviews: readonly WorkflowOverview[],
) => AgentSidebarRow[] {
	let cache = new Map<string, { revision: number; rows: AgentSidebarRow[] }>();
	return (overviews) => {
		const next = new Map<
			string,
			{ revision: number; rows: AgentSidebarRow[] }
		>();
		const rows: AgentSidebarRow[] = [];
		for (const overview of overviews) {
			const key = JSON.stringify([overview.target, overview.state.workflowId]);
			const previous = cache.get(key);
			const revision = overview.state.revision;
			const projected =
				previous && previous.revision === revision
					? previous
					: { revision, rows: projectAgentSidebarRows([overview]) };
			next.set(key, projected);
			rows.push(...projected.rows);
		}
		// Evict workflows absent from the authoritative observation.
		cache = next;
		return rows.sort(compareAgentRows);
	};
}

/** Active is intentionally a run status, not the owning workflow's status. */
export function filterAgentSidebarRows(
	rows: readonly AgentSidebarRow[],
	filter: AgentSidebarFilter,
): AgentSidebarRow[] {
	return filter === "all"
		? [...rows]
		: rows.filter(
				(row) => row.status === "pending" || row.status === "working",
			);
}

export interface AgentSelection {
	/** Preferred row identity survives filtering while it remains in the source. */
	readonly preferredKey?: string;
	/** Visible fallback cursor; -1 when the active filter has no rows. */
	readonly index: number;
}

/** Reconcile selection after a refresh or filter change. A hidden preference is
 * remembered for restoration; it is replaced only after the authoritative
 * source removes that identity. */
export function reconcileAgentSelection(input: {
	readonly selection: AgentSelection;
	readonly sourceRows: readonly AgentSidebarRow[];
	readonly visibleRows: readonly AgentSidebarRow[];
}): AgentSelection {
	const { selection, sourceRows, visibleRows } = input;
	if (visibleRows.length === 0)
		return selection.preferredKey &&
			sourceRows.some((row) => row.key === selection.preferredKey)
			? { ...selection, index: -1 }
			: { index: -1 };
	const preferredIndex = selection.preferredKey
		? visibleRows.findIndex((row) => row.key === selection.preferredKey)
		: -1;
	if (preferredIndex >= 0) return { ...selection, index: preferredIndex };
	const preferredStillExists = selection.preferredKey
		? sourceRows.some((row) => row.key === selection.preferredKey)
		: false;
	const index = Math.min(Math.max(selection.index, 0), visibleRows.length - 1);
	if (preferredStillExists) return { ...selection, index };
	return { preferredKey: visibleRows[index]?.key, index };
}

/** Scroll the list window independently from selection. Wheel input changes only
 * this offset, never the selected row identity. */
export function clampAgentListOffset(
	offset: number,
	rowCount: number,
	visibleCount: number,
): number {
	return Math.min(
		Math.max(0, Math.trunc(offset)),
		Math.max(0, rowCount - Math.max(1, Math.trunc(visibleCount))),
	);
}

export const AGENT_SIDEBAR_WIDTH = 34;
export const AGENT_SIDEBAR_COLLAPSED_WIDTH = 6;
export const SIDEBAR_CONTENT_MIN_WIDTH = 24;

/** Share the panel budget between requested expanded sidebars; unrequested
 * panels retain their compact strip. The body receives the first 24 columns
 * whenever the terminal is wide enough, and both panels shrink before it does. */
export function shellSidebarWidths(input: {
	readonly terminalWidth: number;
	readonly workspaceExpanded: boolean;
	readonly agentExpanded: boolean;
}): { readonly workspace: number; readonly agent: number } {
	const compact = AGENT_SIDEBAR_COLLAPSED_WIDTH;
	let workspace = compact;
	let agent = compact;
	const slots = [
		...(input.workspaceExpanded ? ["workspace" as const] : []),
		...(input.agentExpanded ? ["agent" as const] : []),
	];
	const panelBudget = Math.max(
		0,
		input.terminalWidth - SIDEBAR_CONTENT_MIN_WIDTH,
	);
	const extraBudget = Math.max(0, panelBudget - compact * 2);
	if (slots.length === 1) {
		const width = Math.min(AGENT_SIDEBAR_WIDTH, compact + extraBudget);
		if (slots[0] === "workspace") workspace = width;
		else agent = width;
	} else if (slots.length === 2) {
		const each = Math.min(
			AGENT_SIDEBAR_WIDTH,
			compact + Math.floor(extraBudget / 2),
		);
		workspace = each;
		agent = each;
	}
	// If the terminal itself is narrower than the body budget, compact sidebars
	// still fit within the remaining columns rather than overlapping each other.
	if (workspace + agent > input.terminalWidth) {
		workspace = Math.min(workspace, Math.floor(input.terminalWidth / 2));
		agent = Math.min(agent, input.terminalWidth - workspace);
	}
	return { workspace, agent };
}
