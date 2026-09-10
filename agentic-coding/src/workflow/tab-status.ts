// Pure status-glyph labeling for Herdr agent tabs.
//
// Every agent role tab carries exactly one leading status glyph so the tab
// width never changes as the run progresses: open (`○`), active (`●`),
// done (`✓`), blocked (`■`), failed (`✗`), expired (`·`). Grouped roles
// (verification) share one tab, so multiple runs on the same tab collapse to
// the most urgent status before the label is rendered.
import type { RunStatus } from "./contracts.ts";

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
