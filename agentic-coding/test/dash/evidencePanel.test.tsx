/** @jsxImportSource @opentui/solid */
// The Evidence panel (`evidence-summary-subview`, tasks 2.1/3.1/3.2).
//
// The panel is one line of kind counts, not a listing: the manifest's length is
// the subview's problem, so the row stays at its title plus one summary line
// however much a run attached. The view-model tests below cover the summary, the
// report entry and the height budget; the render tests cover the row itself.
import { expect, test } from "bun:test";
import { createTerminalCapabilities } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";
import type {
	EvidenceEntry,
	EvidenceManifest,
} from "../../src/contracts/environment.ts";
import {
	EVIDENCE_EMPTY_LINES,
	EVIDENCE_KINDS,
	EVIDENCE_PANEL_LINES,
	evidenceDetailLines,
	evidenceKindCounts,
	evidenceKindSummary,
	evidencePanelLines,
	evidenceReportEntry,
	evidenceRows,
} from "../../src/tui/dash/evidence-panel.ts";
import { inlineImagePreview } from "../../src/tui/dash/evidence-report.ts";
import { EvidencePanel } from "../../src/tui/dash/panels/EvidencePanel.tsx";

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

// Oldest first, the order the store's manifest is in.
const RUN_LOG = entry({
	id: "01J000000000000000000000A",
	kind: "log",
	file: "01J000000000000000000000A.log",
	caption: "run log",
	step: "core.planning",
	bytes: 2048,
});
const BEFORE = entry({
	id: "01J000000000000000000000B",
	file: "req-dbg-1/01J000000000000000000000B.png",
	caption: "Before the fix",
});
const AFTER = entry({
	id: "01J000000000000000000000C",
	file: "req-dbg-1/01J000000000000000000000C.png",
	caption: "After the fix",
	role: "worker",
	bytes: 1_240_000,
});
const VIDEO = entry({
	id: "01J000000000000000000000D",
	kind: "video",
	file: "req-dbg-2/01J000000000000000000000D.webm",
	caption: "repro video",
	bytes: 5_000_000,
	poster: "01J000000000000000000000E",
});
const POSTER = entry({
	id: "01J000000000000000000000E",
	file: "req-dbg-2/01J000000000000000000000E.png",
	caption: "final frame",
	bytes: 999,
});
/** The newest flagged entry is the run's report; an older flag stays a listed
 * entry, which is what makes a revised report a second attach rather than an
 * edit. */
const OLD_REPORT = entry({
	id: "01J000000000000000000000F",
	kind: "other",
	file: "01J000000000000000000000F.md",
	caption: "run report",
	report: true,
	bytes: 4096,
});
const REPORT = entry({
	id: "01J000000000000000000000G",
	kind: "other",
	file: "01J000000000000000000000G.md",
	caption: "run report (revised)",
	report: true,
	bytes: 5000,
});

const ENTRIES: EvidenceEntry[] = [RUN_LOG, BEFORE, AFTER, VIDEO, POSTER];
const MANIFEST: EvidenceManifest = {
	workflowId: "wf-1",
	entries: ENTRIES,
	bytes: 6_246_000,
	quotaBytes: 1024 * 1024 * 1024,
};

test("entries read newest first and grouped by debug request", () => {
	expect(
		evidenceRows(ENTRIES).map((row) => [row.header ?? "", row.entry?.id]),
	).toEqual([
		["Debug request dbg-2", POSTER.id],
		["", VIDEO.id],
		["Debug request dbg-1", AFTER.id],
		["", BEFORE.id],
		["", RUN_LOG.id],
	]);
});

test("a row names the kind, caption, producer, time and size", () => {
	const rows = evidenceRows(ENTRIES);
	const label = (id: string) =>
		rows.find((row) => row.entry?.id === id)?.label ?? "";
	expect(label(AFTER.id)).toBe("▣ After the fix · worker · 12:04Z · 1.2 MB");
	expect(label(RUN_LOG.id)).toBe("▤ run log · core.planning · 12:04Z · 2.0 KB");
	// An entry without a caption is still listed, under its kind.
	expect(label(POSTER.id)).toBe("▣ final frame · 12:04Z · 999 B");
	// The flagged report says so: the sidebar must not offer it as browsing
	// material beside the file it *is*.
	expect(evidenceRows([REPORT])[0]?.label).toBe(
		"◇ run report (revised) · report · 12:04Z · 5.0 KB",
	);
});

test("the summary counts kinds in a fixed order with correct plurals", () => {
	expect(evidenceKindSummary(ENTRIES)).toBe("3 screenshots · 1 video · 1 log");
	expect(evidenceKindSummary([AFTER])).toBe("1 screenshot");
	// Every kind is counted, in one fixed order, so the same manifest always
	// paints the same line.
	expect(
		evidenceKindSummary(
			EVIDENCE_KINDS.map((kind, index) => ({
				...AFTER,
				id: `01J00000000000000000000${index}`,
				kind,
			})),
		),
	).toBe("1 screenshot · 1 video · 1 trace · 1 script · 1 log · 1 other");
	expect(evidenceKindCounts(ENTRIES)).toEqual({
		screenshot: 3,
		video: 1,
		trace: 0,
		script: 0,
		log: 1,
		other: 0,
	});
	// Nothing to count is not a summary line of nothing.
	expect(evidenceKindSummary([])).toBe("");
});

test("the report entry is the newest flagged entry", () => {
	expect(evidenceReportEntry([...ENTRIES])).toBeUndefined();
	expect(evidenceReportEntry([...ENTRIES, OLD_REPORT, REPORT])?.id).toBe(
		REPORT.id,
	);
	// Order in the manifest is creation order, so the newest flag wins whichever
	// way the array is read.
	expect(evidenceReportEntry([REPORT, OLD_REPORT])?.id).toBe(REPORT.id);
	expect(evidenceReportEntry([OLD_REPORT, REPORT])?.id).toBe(REPORT.id);
});

test("the detail lines carry the metadata a preview cannot draw", () => {
	expect(evidenceDetailLines(AFTER, "/repo/shot.png")).toEqual([
		"▣ screenshot · 1.2 MB",
		"recorded 2026-01-01T12:04:05.000Z",
		"role worker",
		"After the fix",
		"/repo/shot.png",
	]);
	// A video names its poster, so a metadata-only pane still says which
	// screenshot stands for it.
	expect(evidenceDetailLines(VIDEO)).toContain(`poster ${POSTER.id}`);
});

test("kitty graphics support is the renderer's own answer", () => {
	expect(
		inlineImagePreview(createTerminalCapabilities({ kitty_graphics: true })),
	).toBe(true);
	expect(
		inlineImagePreview(createTerminalCapabilities({ kitty_graphics: false })),
	).toBe(false);
	// A multiplexer that cannot pass images through renders half blocks instead,
	// so the report stays text-only there too.
	expect(
		inlineImagePreview(
			createTerminalCapabilities({ kitty_graphics: true, multiplexer: "tmux" }),
		),
	).toBe(false);
	expect(inlineImagePreview(null)).toBe(false);
	expect(inlineImagePreview(undefined)).toBe(false);
});

test("the panel's height is one summary line, collapsing when empty", () => {
	// A manifest with entries gets the fixed two-line row, however long the
	// manifest is: the reading surface is the subview.
	expect(evidencePanelLines({ entries: 1, state: "ready" })).toBe(
		EVIDENCE_PANEL_LINES,
	);
	expect(evidencePanelLines({ entries: 400, state: "ready" })).toBe(
		EVIDENCE_PANEL_LINES,
	);
	// Nothing attached, and the read that established it succeeded: the title row
	// carries the empty state, so the panel is one line.
	expect(evidencePanelLines({ entries: 0, state: "ready" })).toBe(
		EVIDENCE_EMPTY_LINES,
	);
	// A read in flight, or one that failed, keeps the row that says so.
	expect(evidencePanelLines({ entries: 0, state: "loading" })).toBe(
		EVIDENCE_PANEL_LINES,
	);
	expect(evidencePanelLines({ entries: 0, state: "error" })).toBe(
		EVIDENCE_PANEL_LINES,
	);
});

test("the panel paints the kind summary and no listing", async () => {
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={MANIFEST.entries}
				active
				height={EVIDENCE_PANEL_LINES}
				state="ready"
			/>
		),
		{ width: 120, height: 8 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("3 screenshots"),
	);
	expect(frame).toContain("Evidence");
	expect(frame).toContain("3 screenshots · 1 video · 1 log");
	// No row of the manifest is listed: the panel summarises.
	expect(frame).not.toContain("After the fix");
	// No keybinding hints inside the panel body.
	expect(frame).not.toContain("Enter");
	expect(frame).not.toContain("press");
	const rows = frame.split("\n").filter((line) => line.trim() !== "");
	expect(rows.length).toBeLessThanOrEqual(2);
	t.renderer.destroy();
});

test("the row marks a report and a stage flow without listing them", async () => {
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[...ENTRIES, REPORT]}
				journal={{
					workflowId: "wf-1",
					entries: [
						{
							seq: 1,
							at: "2026-01-01T12:00:00.000Z",
							label: "open the cart",
							segment: 1,
						},
					],
					flowPage: "stage-flow.html",
				}}
				active
				height={EVIDENCE_PANEL_LINES}
				state="ready"
			/>
		),
		{ width: 120, height: 8 },
	);
	const frame = await t.waitForFrame((value) => value.includes("report"));
	expect(frame).toContain("3 screenshots · 1 video · 1 log · 1 other");
	expect(frame).toContain("flow");
	// The journal's step is not listed either: the marker is what says the
	// subview's sidebar is grouped by segment.
	expect(frame).not.toContain("open the cart");
	expect(frame).not.toContain("Segment 1");
	t.renderer.destroy();
});

test("an empty manifest renders a neutral empty state on its title row", async () => {
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[]}
				active
				height={EVIDENCE_EMPTY_LINES}
				state="ready"
			/>
		),
		{ width: 100, height: 6 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("No evidence attached yet"),
	);
	const rows = frame.split("\n");
	// The single row is the title, with the empty state beside it rather than a
	// body that was clipped away.
	expect(rows[0]).toContain("Evidence");
	expect(rows[0]).toContain("No evidence attached yet");
	expect((rows[1] ?? "").trim()).toBe("");
	expect(frame).not.toContain("Enter");
	t.renderer.destroy();
});

test("a read in flight and a failed read are not shown as an empty manifest", async () => {
	const loading = await testRender(
		() => (
			<EvidencePanel
				entries={[]}
				active
				height={EVIDENCE_PANEL_LINES}
				state="loading"
			/>
		),
		{ width: 100, height: 16 },
	);
	const loadingFrame = await loading.waitForFrame((value) =>
		value.includes("Loading evidence…"),
	);
	expect(loadingFrame).not.toContain("No evidence attached yet");
	loading.renderer.destroy();

	const failed = await testRender(
		() => (
			<EvidencePanel
				entries={[]}
				active
				height={EVIDENCE_PANEL_LINES}
				state="error"
				error="the evidence manifest cannot be read"
			/>
		),
		{ width: 120, height: 16 },
	);
	const failedFrame = await failed.waitForFrame((value) =>
		value.includes("Evidence could not be read"),
	);
	expect(failedFrame).toContain("the evidence manifest cannot be read");
	expect(failedFrame).not.toContain("No evidence attached yet");
	failed.renderer.destroy();
});

test("a failed refresh marks the summary that is already on screen", async () => {
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={MANIFEST.entries}
				active
				height={EVIDENCE_PANEL_LINES}
				state="error"
				error="the transport dropped"
			/>
		),
		{ width: 140, height: 16 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("last read failed"),
	);
	// The last-known summary stays visible, and it is marked as stale.
	expect(frame).toContain("3 screenshots");
	t.renderer.destroy();
});

test("the panel mounts no image even on a kitty terminal", async () => {
	// The summary has nothing to draw: only the report pane mounts images, and it
	// mounts them through the subview.
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[...ENTRIES, REPORT]}
				active
				height={EVIDENCE_PANEL_LINES}
				state="ready"
			/>
		),
		{ width: 140, height: 16 },
	);
	const frame = await t.waitForFrame((value) => value.includes("screenshots"));
	expect(frame).not.toMatch(/[\u2580-\u259f]/);
	t.renderer.destroy();
});
