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

const KNOWN_GLYPHS = new Set(Object.values(TAB_STATUS_GLYPHS));

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

/** Remove a previously applied glyph prefix, recovering the role/group name so
 * reconciliation can re-render it idempotently. Labels without a known glyph
 * are returned unchanged. */
export function agentTabBaseLabel(label: string): string {
	const sep = label.indexOf(" ");
	if (sep === 1 && KNOWN_GLYPHS.has(label[0])) return label.slice(2);
	return label;
}
