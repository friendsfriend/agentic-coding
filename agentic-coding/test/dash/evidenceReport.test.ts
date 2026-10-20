// The evidence report's view model (`evidence-summary-subview`, task 2.2).
//
// A report is markdown that cites evidence with the wiki's own inline marker
// `[^<evidence-id>]`. These assertions cover the resolution (a known id keeps its
// marker, an unknown one becomes visibly broken), the section layout the report
// pane renders (markdown blocks with cited screenshots after their citing block,
// then a sources list) and the caps that keep a report bounded.
import { expect, test } from "bun:test";
import type { EvidenceEntry } from "../../src/contracts/environment.ts";
import {
	evidenceCitations,
	evidenceCitedImages,
	evidenceImageFallbackLines,
	evidenceReportSections,
	MAX_REPORT_IMAGES,
	renderEvidenceReport,
} from "../../src/tui/dash/evidence-report.ts";

function entry(
	overrides: Partial<EvidenceEntry> & { id: string },
): EvidenceEntry {
	return {
		kind: "screenshot",
		file: `${overrides.id}.png`,
		caption: "",
		createdAt: "2026-01-01T12:04:05.000Z",
		bytes: 1234,
		...overrides,
	};
}

const SHOT = entry({ id: "01J000000000000000000000A", caption: "empty cart" });
const SECOND = entry({
	id: "01J000000000000000000000B",
	caption: "checkout",
	bytes: 2048,
});
const LOG = entry({
	id: "01J000000000000000000000C",
	kind: "log",
	file: "01J000000000000000000000C.log",
	caption: "run log",
});
const ENTRIES = [SHOT, SECOND, LOG];

test("citations resolve in first-citation order and once each", () => {
	const report = [
		"The cart was empty [^01J000000000000000000000A].",
		"Then checkout [^01J000000000000000000000B] worked, again [^01J000000000000000000000A].",
	].join("\n");
	expect(
		evidenceCitations(report, ENTRIES).map((citation) => [
			citation.id,
			citation.entry?.id,
		]),
	).toEqual([
		[SHOT.id, SHOT.id],
		[SECOND.id, SECOND.id],
	]);
	// A report with no citations resolves to nothing.
	expect(evidenceCitations("plain prose", ENTRIES)).toEqual([]);
});

test("an unknown citation stays visible as a broken marker", () => {
	const report =
		"See [^01J000000000000000000000Z] and [^01J000000000000000000000A].";
	const rendered = renderEvidenceReport(report, ENTRIES);
	// The resolved id keeps the wiki's own marker form; the unknown one says what
	// it is rather than silently vanishing.
	expect(rendered).toContain("[^01J000000000000000000000A]");
	expect(rendered).toContain(
		"**[^01J000000000000000000000Z ⚠ unknown evidence]**",
	);
	expect(rendered).not.toContain("[^01J000000000000000000000Z]");
});

test("sections are the markdown blocks, the cited screenshots and the sources", () => {
	const report = [
		"# Run report",
		"",
		"The cart was empty [^01J000000000000000000000A].",
		"",
		"## After the fix",
		"",
		"Checkout works [^01J000000000000000000000B], logged in [^01J000000000000000000000C].",
	].join("\n");
	const sections = evidenceReportSections(report, ENTRIES);
	expect(sections.map((section) => section.kind)).toEqual([
		"markdown",
		"markdown",
		"image",
		"markdown",
		"markdown",
		"image",
		"sources",
	]);
	// The first image follows the block that first cited it, so the picture is
	// beside the sentence about it.
	const images = sections.flatMap((section) =>
		section.kind === "image" ? [section.entry.id] : [],
	);
	expect(images).toEqual([SHOT.id, SECOND.id]);
	// Only a screenshot is mounted: a cited log is a source row, not a picture.
	const sources = sections.at(-1);
	expect(sources?.kind).toBe("sources");
	if (sources?.kind !== "sources") throw new Error("no sources section");
	expect(sources.rows).toEqual([
		{ label: "▣ empty cart · 12:04Z · 1.2 KB", known: true },
		{ label: "▣ checkout · 12:04Z · 2.0 KB", known: true },
		{ label: "▤ run log · 12:04Z · 1.2 KB", known: true },
	]);
});

test("an unknown citation is a sources row, not a failure", () => {
	const report =
		"Broken [^01J000000000000000000000Z], fine [^01J000000000000000000000A].";
	const sections = evidenceReportSections(report, ENTRIES);
	const sources = sections.at(-1);
	if (sources?.kind !== "sources") throw new Error("no sources section");
	expect(sources.rows).toHaveLength(2);
	expect(sources.rows[0]).toEqual({
		label: "◇ [^01J000000000000000000000Z] · not in this manifest",
		known: false,
	});
	expect(sources.rows[1]?.known).toBe(true);
	// The report still renders: one broken citation does not drop the body.
	expect(sections.some((section) => section.kind === "markdown")).toBe(true);
});

test("a report with no citations has no sources section", () => {
	const sections = evidenceReportSections("Just prose.", ENTRIES);
	expect(sections).toEqual([{ kind: "markdown", source: "Just prose." }]);
});

test("at most MAX_REPORT_IMAGES screenshots are mounted, in citation order", () => {
	const many = Array.from({ length: MAX_REPORT_IMAGES + 2 }, (_, index) =>
		entry({
			id: `01J00000000000000000000${String(index).padStart(2, "0")}`,
			caption: `shot ${index}`,
		}),
	);
	const report = many.map((item) => `- [^${item.id}]`).join("\n");
	const sections = evidenceReportSections(report, many);
	const images = sections.flatMap((section) =>
		section.kind === "image" ? [section.entry.id] : [],
	);
	expect(images).toEqual(
		many.slice(0, MAX_REPORT_IMAGES).map((item) => item.id),
	);
	// Every cited entry is still listed as a source, mounted or not.
	const sources = sections.at(-1);
	if (sources?.kind !== "sources") throw new Error("no sources section");
	expect(sources.rows).toHaveLength(many.length);
	// The same cap is what the route reads bytes for.
	expect(evidenceCitedImages(report, many).map((item) => item.id)).toEqual(
		images,
	);
});

test("a second citation of the same screenshot mounts one image", () => {
	const report = [
		"First [^01J000000000000000000000A].",
		"",
		"Again [^01J000000000000000000000A].",
	].join("\n");
	const sections = evidenceReportSections(report, ENTRIES);
	expect(sections.filter((section) => section.kind === "image")).toHaveLength(
		1,
	);
});

test("a screenshot with no image mounted falls back to its caption and path", () => {
	expect(evidenceImageFallbackLines(SHOT, "/repo/shot.png")).toEqual([
		"▣ empty cart · 12:04Z · 1.2 KB",
		"/repo/shot.png",
	]);
	// Without a path the caption line alone is still true.
	expect(evidenceImageFallbackLines(SHOT)).toHaveLength(1);
});

test("a report body can never paint control characters into the terminal", () => {
	// A report is a file another process wrote. ESC/OSC and C1 bytes are valid
	// UTF-8 with no NUL, so the store's text check accepts them: the display
	// boundary folds them out, and the block structure survives.
	const report = [
		"# Hi\u001b]52;c;AAAA\u0007",
		"",
		"prose\u009b\u001b[2J with a tab\there",
	].join("\r\n");
	// Asserted by code point rather than by character class: the point is that no
	// byte a terminal acts on survives, not which spelling of the range is left.
	const painted = [...renderEvidenceReport(report, ENTRIES)]
		.map((character) => character.codePointAt(0) ?? 0)
		.filter(
			(code) =>
				(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
				(code >= 0x7f && code <= 0x9f),
		);
	expect(painted).toEqual([]);
	// A citation is still rewritten after the strip, so the two rewrites compose.
	const sections = evidenceReportSections(
		`text\u001b[31m [^${SHOT.id}]\u0007`,
		ENTRIES,
	);
	const markdown = sections
		.flatMap((section) => (section.kind === "markdown" ? [section.source] : []))
		.join("\n");
	expect(markdown).not.toContain("\u001b");
	expect(markdown).not.toContain("\u0007");
	expect(markdown).toContain(`[^${SHOT.id}]`);
});

test("a block list handed to the layout is stripped again", () => {
	// The `blocks` shortcut exists so a manifest refresh need not re-lex the
	// report. It must not become a way to render text that skipped the display
	// boundary: every block source is stripped here, whoever produced it.
	const sections = evidenceReportSections(`text [^${SHOT.id}]`, ENTRIES, {
		blocks: [{ source: `raw\u001b[2J \u0007 [^${SHOT.id}]` }],
	});
	const markdown = sections.flatMap((section) =>
		section.kind === "markdown" ? [section.source] : [],
	);
	expect(markdown).toHaveLength(1);
	const source = markdown[0] ?? "";
	expect(source).not.toContain("\u001b");
	expect(source).not.toContain("\u0007");
	expect(source).toContain("raw");
});
