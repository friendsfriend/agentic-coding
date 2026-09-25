// Pure status-glyph labeling for Herdr agent tabs.
//
// Every agent role tab carries exactly one leading status glyph so the tab
// width never changes as the run progresses: open (`○`), active (`●`),
// done (`✓`), blocked (`■`), failed (`✗`), expired (`·`). Each verifier
// role owns its own tab, so a verifier tab shows only that role's status;
// when several roles do share one tab, their runs collapse to the most urgent
// status before the label is rendered.
import type { RunStatus } from "../contracts/workflow.ts";

/** A status plus the single-cell glyph rendered ahead of the tab name. */
export const TAB_STATUS_GLYPHS: Readonly<Record<RunStatus, string>> = {
	pending: "○",
	working: "●",
	completed: "✓",
	blocked: "■",
	failed: "✗",
	expired: "·",
};

/** Highest priority wins when several runs share one tab. `working` and
 * `pending` outrank terminal states so a group tab keeps showing that work is
 * still outstanding; a failure outranks a clean completion. */
const TAB_STATUS_PRIORITY: Readonly<Record<RunStatus, number>> = {
	working: 5,
	pending: 4,
	failed: 3,
	blocked: 2,
	completed: 1,
	expired: 0,
};

/** Leading `<glyph> ` prefixes: a run of non-letter/non-number symbols followed
 * by whitespace. Applied repeatedly so a label that accumulated stale prefixes
 * still collapses to its role/group name. */
const TAB_GLYPH_PREFIX = /^(?:[^\p{L}\p{N}\s]+\s+)+/u;

/** The glyph for one run status. Unknown values fall back to the open glyph so
 * a tab always carries a stable single-cell indicator. */
export function agentTabGlyph(status: string): string {
	return TAB_STATUS_GLYPHS[status as RunStatus] ?? TAB_STATUS_GLYPHS.pending;
}

/** Collapse several run statuses sharing a tab into the one to display. */
export function aggregateAgentTabStatus(statuses: Iterable<string>): RunStatus {
	let selected: RunStatus = "expired";
	for (const status of statuses) {
		const known = Object.hasOwn(TAB_STATUS_GLYPHS, status)
			? (status as RunStatus)
			: "pending";
		if (TAB_STATUS_PRIORITY[known] > TAB_STATUS_PRIORITY[selected])
			selected = known;
	}
	return selected;
}

/** A run reduced to the fields the tab reconcile needs: which tab it occupies,
 * which role it represents, and its status. */
export interface TabStatusRun {
	role: string;
	status: string;
	tabId?: string;
}

/**
 * Reduce a creation-ordered run list to one status per role per tab, keyed by
 * tab id. Within a tab the last run for a role wins, so a superseded attempt,
 * generation, or round can never pin the tab's glyph. Runs without a tab id
 * are ignored — they have no tab to label. Returns a fresh map of tab id to
 * the latest per-role statuses in first-seen role order.
 */
export function latestStatusesByTab(
	runs: Iterable<TabStatusRun>,
): Map<string, string[]> {
	const byTab = new Map<string, Map<string, string>>();
	for (const run of runs) {
		if (!run.tabId) continue;
		let byRole = byTab.get(run.tabId);
		if (!byRole) {
			byRole = new Map<string, string>();
			byTab.set(run.tabId, byRole);
		}
		// Re-setting an existing role keeps its insertion position but overwrites
		// the value, so the last run for that role in creation order wins.
		byRole.set(run.role, run.status);
	}
	const result = new Map<string, string[]>();
	for (const [tabId, byRole] of byTab) result.set(tabId, [...byRole.values()]);
	return result;
}

/** Render a tab label as `<glyph> <base>`. The glyph prefix is a single cell,
 * so repeated updates never change the rendered tab width. */
export function agentTabLabel(base: string, status: string): string {
	return `${agentTabGlyph(status)} ${base}`;
}

/** Remove previously applied glyph prefixes, recovering the role/group name so
 * reconciliation can re-render it idempotently. Labels without a glyph prefix
 * are returned unchanged. */
export function agentTabBaseLabel(label: string): string {
	return label.replace(TAB_GLYPH_PREFIX, "");
}

/** Glyph-aware tab name comparison: true when a rendered label identifies the
 * given role/group base, regardless of which status glyph precedes it. This is
 * the single mechanism every Herdr tab-name lookup uses. */
export function agentTabMatchesBase(
	label: string | undefined,
	base: string,
): boolean {
	return label !== undefined && agentTabBaseLabel(label) === base;
}

/** Find the first tab (out of a Herdr `tab list` result) whose base label is
 * `base`, ignoring any leading status glyph. */
export function findAgentTabByBase<T extends { label?: string }>(
	tabs: Iterable<T>,
	base: string,
): T | undefined {
	for (const tab of tabs) if (agentTabMatchesBase(tab.label, base)) return tab;
	return undefined;
}
