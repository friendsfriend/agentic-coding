// The Evidence panel's pure view model (`add-dashboard-evidence-panel` tasks
// 2.1/2.2, reworked into the summary by `evidence-summary-subview`).
//
// Manifest in, display data out: the one-line kind summary the panel paints, the
// report entry the subview renders, the grouping by debug request or stage flow,
// the one-line label of each row, and the metadata lines beside the list. No I/O
// and no clock — the manifest already carries every timestamp this reads.
//
// The request an entry belongs to is read from the stored file name through the
// evidence store's own inverse (`evidenceRequestIdOf`), never re-derived from
// the `req-` convention here.
import {
	EVIDENCE_KINDS as CONTRACT_EVIDENCE_KINDS,
	type EvidenceEntry,
	type EvidenceKind,
} from "../../contracts/environment.ts";
import type {
	StageJournal,
	StageJournalEntry,
} from "../../contracts/stages.ts";
import { flowOffsetLabel, formatBytes } from "../../workflow/format.ts";
import { evidenceRequestIdOf } from "../../workflow/runtime/evidence-store.ts";

/** What the manifest read is doing. `ready` with nothing attached is a fact the
 * read established — the run produced no evidence — not a default. */
export type EvidenceReadState = "loading" | "ready" | "error";

/** The Evidence panel's height in lines when the manifest has something to
 * summarise or the read did not succeed: its title row and the one summary
 * line. The height is a display budget and never the manifest's length — the
 * reading surface is the subview, so a long manifest costs the panels above it
 * nothing. */
export const EVIDENCE_PANEL_LINES = 2;

/** The height for a read that succeeded with nothing attached: the single title
 * row carries the empty state, so a run with no evidence spends one line. */
export const EVIDENCE_EMPTY_LINES = 1;

/** The order the summary counts kinds in: the contract's own list, which is fixed,
 * so the same manifest always paints the same line and a kind added to the
 * contract cannot silently drop out of the summary. */
export const EVIDENCE_KINDS: readonly EvidenceKind[] = Object.freeze([
	...CONTRACT_EVIDENCE_KINDS,
]);

/** The plural each kind is counted under. */
const KIND_PLURAL: Readonly<Record<EvidenceKind, string>> = Object.freeze({
	screenshot: "screenshots",
	video: "videos",
	trace: "traces",
	script: "scripts",
	log: "logs",
	other: "others",
});

/**
 * The Evidence row's height in lines for one read state.
 *
 * Bounded on purpose: the panel is the last row of the detail grid, so every
 * line it takes is a line the panels above it (the agents list in particular) do
 * not get. It is the title row plus at most one summary row, and collapses to
 * the title row while the run has attached nothing.
 */
export function evidencePanelLines(input: {
	/** How many entries the manifest holds: the summary is one line whether the
	 * manifest has one entry or a thousand. */
	readonly entries: number;
	readonly state: EvidenceReadState;
}): number {
	if (input.state !== "ready") return EVIDENCE_PANEL_LINES;
	return input.entries > 0 ? EVIDENCE_PANEL_LINES : EVIDENCE_EMPTY_LINES;
}

/** How many entries of each kind the manifest holds. */
export function evidenceKindCounts(
	entries: readonly EvidenceEntry[],
): Readonly<Record<EvidenceKind, number>> {
	const counts: Record<EvidenceKind, number> = {
		screenshot: 0,
		video: 0,
		trace: 0,
		script: 0,
		log: 0,
		other: 0,
	};
	for (const entry of entries) counts[entry.kind] += 1;
	return counts;
}

/**
 * The panel's one summary line: the kind counts in fixed order, singular and
 * plural correct, with zero-count kinds omitted (`3 screenshots · 10 logs ·
 * 1 video`). A manifest with no entries has nothing to count, so the caller
 * paints its empty state instead.
 */
export function evidenceKindSummary(entries: readonly EvidenceEntry[]): string {
	const counts = evidenceKindCounts(entries);
	return EVIDENCE_KINDS.filter((kind) => counts[kind] > 0)
		.map((kind) =>
			counts[kind] === 1 ? `1 ${kind}` : `${counts[kind]} ${KIND_PLURAL[kind]}`,
		)
		.join(" · ");
}

/**
 * The workflow's report: the newest entry carrying the `report` flag. The store's
 * ids are its own ordering key — an id's time prefix is creation order, and
 * attaches are serialized under the evidence-root lock and nudged forward when
 * two land in the same millisecond, so the greatest id is the last report
 * committed. A revised report is a second flagged entry, so an older one stays an
 * ordinary listed entry and reading "the report" needs no mutation of the
 * manifest.
 *
 * A scan, not a sort: the answer is one maximum, and this runs on every manifest
 * refresh from two memos (the route's report read and the panel's marker).
 */
export function evidenceReportEntry(
	entries: readonly EvidenceEntry[],
): EvidenceEntry | undefined {
	let newest: EvidenceEntry | undefined;
	for (const entry of entries)
		if (
			entry.report === true &&
			(newest === undefined || entry.id.localeCompare(newest.id) > 0)
		)
			newest = entry;
	return newest;
}

/** Whether the manifest holds a report at all: the panel's `report` marker needs
 * existence, never the entry, so it costs one pass and no comparator. */
export function evidenceHasReport(entries: readonly EvidenceEntry[]): boolean {
	return entries.some((entry) => entry.report === true);
}

/** One marker on an Evidence surface's title row. */
export interface EvidenceMarker {
	readonly text: string;
	readonly failure: boolean;
}

/**
 * The marker a surface carries for the manifest read once it already paints a
 * listing: a refresh that failed is marked wherever the entries are shown — the
 * grid's summary row and the subview's sidebar both — so a stale list is never
 * passed off as a live one. A read in flight over rows that are already painted
 * needs no marker; the rows are the answer until the read replaces them.
 */
export function evidenceReadFailureMarker(
	state: EvidenceReadState,
): EvidenceMarker | undefined {
	return state === "error"
		? { text: "last read failed", failure: true }
		: undefined;
}

/** One row of the evidence list. A row either selects an evidence entry or — in
 * a workflow that has a stage flow journal — a journal step, which has no file
 * to open; the row that opens a group carries its heading. */
export interface EvidenceListRow {
	readonly entry?: EvidenceEntry;
	/** The journal step this row stands for, when it is a step row. */
	readonly step?: StageJournalEntry;
	/** The one-line label the list paints. */
	readonly label: string;
	/** Heading of the group this row opens, when it opens one. */
	readonly header?: string;
}

/** The glyph a journal step row leads with, so a step is distinguishable from
 * the evidence rows around it. */
const STEP_GLYPH = "›";

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

/** One entry's row label: kind, caption, producing step or role, time, size. A
 * flagged report says so, so the sidebar does not mistake it for browsing
 * material. */
export function evidenceRowLabel(entry: EvidenceEntry): string {
	const parts = [entry.caption.trim() || entry.kind];
	if (entry.report === true) parts.push("report");
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
 *
 * A workflow that has a stage flow journal gets the flow grouping instead
 * (`add-stage-flow-evidence`), which is the grouping the subview's sidebar keeps;
 * one that has none renders exactly as before.
 */
export function evidenceRows(
	entries: readonly EvidenceEntry[],
	journal?: StageJournal,
): EvidenceListRow[] {
	if (journal === undefined || journal.entries.length === 0)
		return evidenceRequestRows(entries);
	return evidenceFlowRows(entries, journal);
}

/** The grouping this panel has always had: by debug request, newest first. */
function evidenceRequestRows(
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

/** One journal step's row label: its offset, its label, and where it ran. */
export function evidenceStepLabel(step: StageJournalEntry): string {
	const parts = [
		step.offsetMs === undefined ? "" : flowOffsetLabel(step.offsetMs),
		step.label,
	]
		.filter(Boolean)
		.join(" ");
	const where = [step.app, step.role].filter(Boolean).join("/");
	return `${STEP_GLYPH} ${parts}${where === "" ? "" : ` · ${where}`}`;
}

/** What one journal step says, for the sidebar's detail rows: where and when it
 * ran, what it expected and saw, and what it captured. A step has no file, so
 * this is all a developer can be told about it besides its row. */
export function evidenceStepDetailLines(step: StageJournalEntry): string[] {
	const lines: string[] = [];
	const where = [step.app, step.role].filter(Boolean).join(" / ");
	const when =
		step.offsetMs === undefined ? "" : flowOffsetLabel(step.offsetMs);
	lines.push(
		[when, where].filter(Boolean).join(" · ") ||
			(step.segment === undefined ? "step" : `segment ${step.segment}`),
	);
	if (step.url !== undefined) lines.push(step.url);
	if (step.expected !== undefined) lines.push(`expected ${step.expected}`);
	if (step.observed !== undefined) lines.push(`observed ${step.observed}`);
	for (const [name, value] of Object.entries(step.captures ?? {}))
		lines.push(`${name} ${value}`);
	if (step.knowledge !== undefined) {
		const { concept, section, kind } = step.knowledge;
		lines.push(
			`knowledge ${kind} ${concept}${section === undefined ? "" : ` § ${section}`}`,
		);
	}
	return lines;
}

/** The flow grouping: one group per recording segment in journal order, each
 * with the steps written during it and the evidence they reference, then a
 * trailing group for whatever no segment claimed. */
function evidenceFlowRows(
	entries: readonly EvidenceEntry[],
	journal: StageJournal,
): EvidenceListRow[] {
	/** Segment order is journal order: the first step's segment comes first. */
	const segments = new Map<number, StageJournalEntry[]>();
	const loose: StageJournalEntry[] = [];
	for (const step of journal.entries) {
		if (step.segment === undefined) {
			loose.push(step);
			continue;
		}
		const group = segments.get(step.segment);
		if (group) group.push(step);
		else segments.set(step.segment, [step]);
	}
	/** Which segment an entry belongs to: the one a step of it referenced, the
	 * one the kept video itself names, or the one whose poster it is. A
	 * screenshot taken while a recording ran carries no segment of its own, so
	 * the step that named it is what files it. */
	const segmentOf = new Map<string, number>();
	for (const [segment, steps] of segments)
		for (const step of steps)
			for (const id of step.evidence ?? [])
				if (!segmentOf.has(id)) segmentOf.set(id, segment);
	for (const entry of entries) {
		if (entry.segment !== undefined && !segmentOf.has(entry.id))
			segmentOf.set(entry.id, entry.segment);
		if (entry.poster !== undefined && !segmentOf.has(entry.poster)) {
			const owner = segmentOf.get(entry.id);
			if (owner !== undefined) segmentOf.set(entry.poster, owner);
		}
	}
	const claimed = new Set<string>();
	const rows: EvidenceListRow[] = [];
	for (const [segment, steps] of segments) {
		const groupEntries = [...entries]
			.filter((entry) => segmentOf.get(entry.id) === segment)
			.sort((left, right) => right.id.localeCompare(left.id));
		for (const entry of groupEntries) claimed.add(entry.id);
		const video = groupEntries.find(
			(entry) => entry.kind === "video" && entry.segment === segment,
		);
		const heading = [
			`Segment ${segment}`,
			video ? evidenceRowLabel(video).replace(/^▶ /, "") : "",
		]
			.filter(Boolean)
			.join(" · ");
		steps.forEach((step, index) => {
			rows.push({
				step,
				label: evidenceStepLabel(step),
				...(index === 0 ? { header: heading } : {}),
			});
		});
		for (const entry of groupEntries)
			rows.push({ entry, label: evidenceRowLabel(entry) });
	}
	const rest = [
		...loose.map((step) => ({ step, label: evidenceStepLabel(step) })),
		...[...entries]
			.filter((entry) => !claimed.has(entry.id))
			.sort((left, right) => right.id.localeCompare(left.id))
			.map((entry) => ({ entry, label: evidenceRowLabel(entry) })),
	];
	rest.forEach((row, index) => {
		rows.push({ ...row, ...(index === 0 ? { header: "Unreferenced" } : {}) });
	});
	return rows;
}

/**
 * The metadata lines beside the sidebar list: what the entry is and how large it
 * is, when it was recorded, who produced it, where it came from, its caption,
 * and — when the route could compose it — the local path of the stored file.
 * This is the non-kitty text fallback the report pane and the sidebar share.
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
