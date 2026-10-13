// The Evidence panel's pure view model (add-dashboard-evidence-panel, tasks
// 2.1/2.2).
//
// Manifest in, display data out: the grouping by debug request, the one-line
// label of each entry, the entry whose bytes the preview renders, and the
// metadata lines a terminal without kitty graphics gets instead. No I/O and no
// clock — the manifest already carries every timestamp this reads.
//
// The request an entry belongs to is read from the stored file name through the
// evidence store's own inverse (`evidenceRequestIdOf`), never re-derived from
// the `req-` convention here.
import type {
	EvidenceEntry,
	EvidenceKind,
} from "../../contracts/environment.ts";
import { formatBytes } from "../../workflow/format.ts";
import { evidenceRequestIdOf } from "../../workflow/runtime/evidence-store.ts";

/** What the manifest read is doing. `ready` with nothing attached is a fact the
 * read established — the run produced no evidence — not a default. */
export type EvidenceReadState = "loading" | "ready" | "error";

/** The Evidence panel's height in lines when the manifest has something to
 * list: its title row and a short body. The listing scrolls inside that body,
 * so the panel's height is a display budget and never the manifest's length. */
export const EVIDENCE_PANEL_LINES = 8;

/** The height for a read in flight or a read that failed with nothing to list:
 * the title row and the one message that says so. */
export const EVIDENCE_MESSAGE_LINES = 2;

/** The height for a read that succeeded with nothing attached: the single title
 * row carries the empty state, so a run with no evidence spends one line. */
export const EVIDENCE_EMPTY_LINES = 1;

/** The share of the host's rows the compact height is allowed to fill. Only a
 * short terminal reads it: the fixed height is what the panel asks for, and
 * this keeps the grid above it from being crowded on a very small window. */
const EVIDENCE_PANEL_SHARE = 0.3;

/**
 * The Evidence row's height in lines for one read state.
 *
 * Bounded on purpose: the panel is the last row of the detail grid, so every
 * line it takes is a line the panels above it (the agents list in particular)
 * do not get. It is compact by default, collapses to its title row while the
 * run has attached nothing, and never grows with the manifest — the listing
 * windows itself instead.
 */
export function evidencePanelLines(input: {
	/** How many entries the read answered with. */
	readonly entries: number;
	readonly state: EvidenceReadState;
	/** The terminal's rows. A cap only: the host's chrome may leave the dashboard
	 * fewer rows than this, which is why the panels measure their own body. */
	readonly terminalLines: number;
}): number {
	if (input.entries === 0)
		return input.state === "ready"
			? EVIDENCE_EMPTY_LINES
			: EVIDENCE_MESSAGE_LINES;
	const cap = Math.max(
		EVIDENCE_MESSAGE_LINES,
		Math.round(input.terminalLines * EVIDENCE_PANEL_SHARE),
	);
	return Math.min(EVIDENCE_PANEL_LINES, cap);
}

/** One row of the panel's list. Every row selects an entry; the row that opens
 * a debug request's group also carries its heading. */
export interface EvidenceListRow {
	readonly entry: EvidenceEntry;
	/** The one-line label the list paints. */
	readonly label: string;
	/** Heading of the group this row opens, when it opens one. */
	readonly header?: string;
}

/** The glyph each kind leads with, so a row is scannable without reading the
 * caption. */
const KIND_GLYPH: Readonly<Record<EvidenceKind, string>> = Object.freeze({
	screenshot: "▣",
	video: "▶",
	trace: "◆",
	script: "❯",
	log: "▤",
	other: "◇",
});

/** The recording time of one entry, from its own ISO timestamp. UTC is the
 * only timezone the manifest records, so it is named rather than guessed. */
function recordedTime(entry: EvidenceEntry): string {
	return entry.createdAt.length >= 16
		? `${entry.createdAt.slice(11, 16)}Z`
		: entry.createdAt;
}

/** One entry's row label: kind, caption, producing step or role, time, size. */
export function evidenceRowLabel(entry: EvidenceEntry): string {
	const parts = [entry.caption.trim() || entry.kind];
	const producer = entry.step ?? entry.role;
	if (producer) parts.push(producer);
	parts.push(recordedTime(entry));
	if (entry.bytes !== undefined) parts.push(formatBytes(entry.bytes));
	return `${KIND_GLYPH[entry.kind]} ${parts.join(" · ")}`;
}

/**
 * Every entry of a manifest, newest first, grouped by the debug request it was
 * attached under. ULIDs are time-ordered, so newest-first is the id sorted
 * descending; a request's entries stay together and the groups themselves are
 * ordered by their newest entry, so the most recent work is at the top.
 */
export function evidenceRows(
	entries: readonly EvidenceEntry[],
): EvidenceListRow[] {
	const newestFirst = [...entries].sort((left, right) =>
		right.id.localeCompare(left.id),
	);
	// Insertion order is first-appearance order, which is newest-first order.
	const groups = new Map<string, EvidenceEntry[]>();
	for (const entry of newestFirst) {
		const requestId = evidenceRequestIdOf(entry.file) ?? "";
		const group = groups.get(requestId);
		if (group) group.push(entry);
		else groups.set(requestId, [entry]);
	}
	const rows: EvidenceListRow[] = [];
	for (const [requestId, group] of groups)
		group.forEach((entry, index) => {
			rows.push({
				entry,
				label: evidenceRowLabel(entry),
				...(index === 0 && requestId !== ""
					? { header: `Debug request ${requestId}` }
					: {}),
			});
		});
	return rows;
}

/**
 * The entry whose bytes the preview renders for `selectedIndex`: the entry
 * itself when it is a screenshot, or the screenshot a video names as its
 * poster. Every other kind — and a video without a poster — has no image of its
 * own, so the preview stays metadata: a video's bytes are never decoded inline.
 */
export function evidencePreviewEntry(
	rows: readonly EvidenceListRow[],
	selectedIndex: number,
): EvidenceEntry | undefined {
	const entry = rows[selectedIndex]?.entry;
	if (!entry) return undefined;
	if (entry.kind === "screenshot") return entry;
	if (entry.kind !== "video" || !entry.poster) return undefined;
	const poster = rows.find(
		(candidate) => candidate.entry.id === entry.poster,
	)?.entry;
	// Only a screenshot is an image: a poster that names a trace, a log or
	// another video leaves the preview at metadata rather than mounting bytes the
	// renderer cannot decode.
	return poster?.kind === "screenshot" ? poster : undefined;
}

/**
 * The metadata lines the preview shows: what the entry is and how large it is,
 * when it was recorded, who produced it, where it came from, its caption, and —
 * when the route could compose it — the local path of the stored file.
 */
export function evidenceDetailLines(
	entry: EvidenceEntry,
	path?: string,
): string[] {
	const lines = [
		`${KIND_GLYPH[entry.kind]} ${entry.kind} · ${
			entry.bytes === undefined ? "size unknown" : formatBytes(entry.bytes)
		}`,
		`recorded ${entry.createdAt}`,
	];
	const producer = [
		entry.step ? `step ${entry.step}` : "",
		entry.role ? `role ${entry.role}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	if (producer) lines.push(producer);
	if (entry.app) lines.push(`app ${entry.app}`);
	if (entry.url) lines.push(entry.url);
	if (entry.poster) lines.push(`poster ${entry.poster}`);
	const caption = entry.caption.trim();
	if (caption) lines.push(caption);
	if (path) lines.push(path);
	return lines;
}
