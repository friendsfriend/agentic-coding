// The evidence report's pure view model (`evidence-summary-subview`, task 2.2).
//
// A report is one manifest entry flagged `report: true`: markdown text an agent
// attached, citing evidence with the wiki's own inline marker `[^<evidence-id>]`.
// This module resolves those markers against the manifest and lays the report out
// as the sections the subview's left pane renders — one markdown block per
// top-level block, an image section for each cited screenshot, and a trailing
// sources list. No I/O: the report text and the manifest are parameters, and the
// route owns the reads.
//
// Rendering reuses the wiki's renderer (`parseMarkdownBlocks` / `MarkdownBlockView`
// from `@ui`) rather than a second markdown implementation, so a citation reads
// the same in a note and in a report.
import type { TerminalCapabilities } from "@opentui/core";
import { resolveImageRenderProtocol } from "@opentui/core";
import { parseMarkdownBlocks } from "@ui";
import type { EvidenceEntry } from "../../contracts/environment.ts";
import { evidenceRowLabel } from "./evidence-panel.ts";

/** At most this many cited screenshots are mounted inline: a report that cites a
 * dozen pictures should not read every one of them off disk. */
export const MAX_REPORT_IMAGES = 4;

/** The wiki's inline citation marker (`workflow/wiki.ts`): the id matches a
 * manifest entry id, so one syntax covers notes and reports. */
const CITATION = /\[\^([A-Za-z0-9][A-Za-z0-9._-]*)\]/g;

/** The bold words a citation to an id the manifest does not hold becomes. Weight
 * is what stays visible under any theme or a monochrome terminal, where colour
 * cannot mark one token of a rendered block. */
export function unknownCitationMarker(id: string): string {
	return `**[^${id} ⚠ unknown evidence]**`;
}

/**
 * Whether the renderer will draw an inline image. The terminal capability probe
 * it ran is the only source — `$TERM` is never sniffed — and the decision is the
 * image renderable's own (`resolveImageRenderProtocol`), so the report never
 * mounts a picture the renderer would paint as half blocks instead: a terminal
 * without kitty graphics, and one behind a multiplexer that cannot pass images
 * through, both answer `false` and get the text fallback.
 */
export function inlineImagePreview(
	capabilities: TerminalCapabilities | null | undefined,
): boolean {
	return (
		resolveImageRenderProtocol("auto", capabilities ?? null, false) === "kitty"
	);
}

/** One citation of a report: its id, and the entry it resolved to when the
 * manifest holds it. */
export interface EvidenceCitation {
	readonly id: string;
	readonly entry?: EvidenceEntry;
}

/** One row of the report's sources section. An unknown row is a citation the
 * manifest does not hold, which is reported rather than treated as a failure. */
export interface EvidenceSourceRow {
	readonly label: string;
	readonly known: boolean;
}

/** One section of the report pane, in the order the pane paints them. */
export type EvidenceReportSection =
	| { readonly kind: "markdown"; readonly source: string }
	| { readonly kind: "image"; readonly entry: EvidenceEntry }
	| { readonly kind: "sources"; readonly rows: readonly EvidenceSourceRow[] };

/** The entries of one manifest by id, so a citation resolves in one lookup. */
function entriesById(
	entries: readonly EvidenceEntry[],
): ReadonlyMap<string, EvidenceEntry> {
	return new Map(entries.map((entry) => [entry.id, entry]));
}

/** Every cited id, in first-citation order and once each. */
export function evidenceCitations(
	report: string,
	entries: readonly EvidenceEntry[],
): EvidenceCitation[] {
	const byId = entriesById(entries);
	const seen = new Set<string>();
	const citations: EvidenceCitation[] = [];
	for (const match of report.matchAll(CITATION)) {
		const id = match[1];
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const entry = byId.get(id);
		citations.push(entry === undefined ? { id } : { id, entry });
	}
	return citations;
}

/** A report with every character a terminal would act on folded out. A report is
 * a file another process wrote — a stage test, a repository the run read — so its
 * body can carry ESC/OSC/CSI sequences that every validated manifest field
 * (`evidenceText`) and every recorded summary already rejects. They are dropped
 * here, at the display boundary, while block structure (tab, newline, carriage
 * return) is kept so headings and code fences still read. Written as a predicate
 * rather than a character class so the rule reads as the ranges it is, and with a
 * scan that allocates nothing for the common case: a clean report is returned
 * unchanged, so the per-refresh rewrite costs one pass and no string. */
function stripControlCharacters(text: string): string {
	let index = 0;
	while (index < text.length && !isControlCode(text.charCodeAt(index)))
		index += 1;
	if (index === text.length) return text;
	let visible = text.slice(0, index);
	for (; index < text.length; index += 1)
		if (!isControlCode(text.charCodeAt(index))) visible += text[index];
	return visible;
}

/** Whether one UTF-16 code unit is a character the terminal would act on: every
 * C0 control except tab, newline and carriage return, and the C1 block. */
function isControlCode(code: number): boolean {
	return (
		(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
		(code >= 0x7f && code <= 0x9f)
	);
}

/**
 * The report text with every citation marker resolved: a resolved id keeps the
 * wiki's own marker, an unresolved one becomes a visibly broken marker. The
 * pane renders this rewritten text, never the markdown engine's footnote
 * handling, so an unknown citation can never silently disappear. Control
 * characters are folded out of the body before any of that, so a report can never
 * write escape sequences into the operator's terminal.
 */
export function renderEvidenceReport(
	report: string,
	entries: readonly EvidenceEntry[],
): string {
	const byId = entriesById(entries);
	return stripControlCharacters(report).replace(
		CITATION,
		(marker, id: string) => (byId.has(id) ? marker : unknownCitationMarker(id)),
	);
}

/**
 * The screenshots a report cites, in citation order and at most
 * `MAX_REPORT_IMAGES`: the entries whose bytes the route reads for the inline
 * branch, whether or not the terminal can draw them.
 */
export function evidenceCitedImages(
	report: string,
	entries: readonly EvidenceEntry[],
): EvidenceEntry[] {
	return evidenceCitations(report, entries)
		.flatMap((citation) =>
			citation.entry?.kind === "screenshot" ? [citation.entry] : [],
		)
		.slice(0, MAX_REPORT_IMAGES);
}

/**
 * The report pane's sections: every top-level markdown block in document order,
 * an image section directly after the block that first cites each screenshot
 * (capped at `MAX_REPORT_IMAGES`), and a trailing sources section listing every
 * citation with its entry's row label — plus one row per id the manifest does not
 * hold. A report with no citations has no sources section.
 *
 * `blocks` is the shortcut for a caller that already lexed the document
 * `renderEvidenceReport` returns: a manifest refresh then resolves citations
 * again without re-running the tokenizer. It is not a way to render different
 * text — every block source is stripped again here, so a block list that did not
 * come from `renderEvidenceReport` still cannot paint an escape sequence.
 */
export function evidenceReportSections(
	report: string,
	entries: readonly EvidenceEntry[],
	options: { readonly blocks?: readonly { readonly source: string }[] } = {},
): EvidenceReportSection[] {
	const citations = evidenceCitations(report, entries);
	const resolved = new Map<string, EvidenceEntry>();
	for (const citation of citations)
		if (citation.entry) resolved.set(citation.id, citation.entry);
	const sections: EvidenceReportSection[] = [];
	const placed = new Set<string>();
	const blocks =
		options.blocks ??
		parseMarkdownBlocks(renderEvidenceReport(report, entries));
	for (const block of blocks) {
		sections.push({
			kind: "markdown",
			source: stripControlCharacters(block.source),
		});
		for (const match of block.source.matchAll(CITATION)) {
			const id = match[1];
			if (!id || placed.has(id) || placed.size >= MAX_REPORT_IMAGES) continue;
			const entry = resolved.get(id);
			if (entry?.kind !== "screenshot") continue;
			placed.add(id);
			sections.push({ kind: "image", entry });
		}
	}
	const rows: EvidenceSourceRow[] = citations.map((citation) =>
		citation.entry
			? { label: evidenceRowLabel(citation.entry), known: true }
			: { label: `◇ [^${citation.id}] · not in this manifest`, known: false },
	);
	if (rows.length > 0) sections.push({ kind: "sources", rows });
	return sections;
}

/**
 * The text a cited screenshot gets when no image is mounted — a terminal without
 * kitty graphics, or bytes that have not loaded: its caption and size, then its
 * stored path when the route could compose it.
 */
export function evidenceImageFallbackLines(
	entry: EvidenceEntry,
	path?: string,
): string[] {
	return [evidenceRowLabel(entry), ...(path === undefined ? [] : [path])];
}
