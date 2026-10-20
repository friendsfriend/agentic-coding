/** @jsxImportSource @opentui/solid */
// The Evidence panel (add-dashboard-evidence-panel, tasks 2.1/2.2).
//
// The listing is every manifest entry, newest first and grouped by the debug
// request it was attached under; the preview renders an inline image when the
// renderer reports kitty graphics and metadata only when it does not — with the
// bytes never even read in that branch, so a terminal that cannot show the
// picture is never sent one.
import { expect, test } from "bun:test";
import { createTerminalCapabilities } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";
import type {
	EvidenceEntry,
	EvidenceManifest,
} from "../../src/contracts/environment.ts";
import {
	EVIDENCE_EMPTY_LINES,
	EVIDENCE_MESSAGE_LINES,
	EVIDENCE_PANEL_LINES,
	evidenceDetailLines,
	evidencePanelLines,
	evidencePreviewEntry,
	evidenceRows,
} from "../../src/tui/dash/evidence-panel.ts";
import {
	EvidencePanel,
	inlineImagePreview,
} from "../../src/tui/dash/panels/EvidencePanel.tsx";

/** A 1×1 PNG: the smallest thing the image renderable decodes. */
const PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	),
	(character) => character.charCodeAt(0),
);

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
});

test("the preview renders a screenshot or a video's poster, never a video", () => {
	const rows = evidenceRows(ENTRIES);
	const index = (id: string) => rows.findIndex((row) => row.entry?.id === id);
	expect(evidencePreviewEntry(rows, index(AFTER.id))?.id).toBe(AFTER.id);
	// A video's own bytes are never decoded inline: its poster stands in.
	expect(evidencePreviewEntry(rows, index(VIDEO.id))?.id).toBe(POSTER.id);
	expect(evidencePreviewEntry(rows, index(RUN_LOG.id))).toBeUndefined();
	expect(evidencePreviewEntry(rows, 99)).toBeUndefined();
});

test("a poster that is not a screenshot leaves the preview at metadata", () => {
	// The contract pins `poster` to a string, not to a screenshot: a video that
	// names a trace would otherwise mount bytes the renderer cannot decode.
	const rows = evidenceRows(
		ENTRIES.map((item) =>
			item.id === VIDEO.id ? { ...item, poster: RUN_LOG.id } : item,
		),
	);
	const index = rows.findIndex((row) => row.entry?.id === VIDEO.id);
	expect(evidencePreviewEntry(rows, index)).toBeUndefined();
});

test("the detail lines carry the metadata a preview cannot draw", () => {
	expect(evidenceDetailLines(AFTER, "/repo/shot.png")).toEqual([
		"▣ screenshot · 1.2 MB",
		"recorded 2026-01-01T12:04:05.000Z",
		"role worker",
		"After the fix",
		"/repo/shot.png",
	]);
	// A video names its poster, so a metadata-only preview still says which
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
	// so the panel stays metadata-only there too.
	expect(
		inlineImagePreview(
			createTerminalCapabilities({ kitty_graphics: true, multiplexer: "tmux" }),
		),
	).toBe(false);
	expect(inlineImagePreview(null)).toBe(false);
	expect(inlineImagePreview(undefined)).toBe(false);
});

test("the panel's height is compact, collapses when empty and is capped on a short terminal", () => {
	// A manifest with entries gets the fixed compact height, however long the
	// manifest is: the listing windows itself instead of growing the row.
	expect(
		evidencePanelLines({ rows: 1, state: "ready", terminalLines: 60 }),
	).toBe(EVIDENCE_PANEL_LINES);
	expect(
		evidencePanelLines({ rows: 40, state: "ready", terminalLines: 60 }),
	).toBe(EVIDENCE_PANEL_LINES);
	// Nothing attached, and the read that established it succeeded: the title row
	// carries the empty state, so the panel is one line.
	expect(
		evidencePanelLines({ rows: 0, state: "ready", terminalLines: 60 }),
	).toBe(EVIDENCE_EMPTY_LINES);
	// A read in flight, or one that failed with nothing to list, keeps the row
	// that says so.
	expect(
		evidencePanelLines({ rows: 0, state: "loading", terminalLines: 60 }),
	).toBe(EVIDENCE_MESSAGE_LINES);
	expect(
		evidencePanelLines({ rows: 0, state: "error", terminalLines: 60 }),
	).toBe(EVIDENCE_MESSAGE_LINES);
	// A short terminal scales the panel down instead of letting it crowd the grid
	// above it.
	expect(
		evidencePanelLines({ rows: 3, state: "ready", terminalLines: 12 }),
	).toBe(4);
	expect(
		evidencePanelLines({ rows: 3, state: "ready", terminalLines: 8 }),
	).toBe(EVIDENCE_MESSAGE_LINES);
	// A workflow whose flow journal wrote steps and attached no evidence has rows
	// to paint, so it gets the fixed height rather than the empty state's one line:
	// the count is of painted rows, not of entries.
	expect(
		evidencePanelLines({ rows: 2, state: "ready", terminalLines: 60 }),
	).toBe(EVIDENCE_PANEL_LINES);
});

test("an empty listing collapses the panel to its title row", async () => {
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[]}
				active
				selectedIndex={0}
				kitty={false}
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
	t.renderer.destroy();
});

test("a collapsed panel that failed to read still says so", async () => {
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[]}
				active
				selectedIndex={0}
				kitty={false}
				height={EVIDENCE_EMPTY_LINES}
				state="error"
				error="the evidence manifest cannot be read"
			/>
		),
		{ width: 120, height: 6 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("Evidence could not be read"),
	);
	expect(frame).toContain("the evidence manifest cannot be read");
	t.renderer.destroy();
});

test("the panel lists the manifest with each debug request's heading", async () => {
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={MANIFEST.entries}
				active
				selectedIndex={2}
				kitty={false}
				path="/repo/.herdr-workflow/evidence/wf-1/req-dbg-1/01J000000000000000000000C.png"
				height={12}
			/>
		),
		{ width: 140, height: 24 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("Debug request dbg-2"),
	);
	expect(frame).toContain("Evidence");
	expect(frame).toContain("Debug request dbg-1");
	expect(frame).toContain("▶ repro video · 12:04Z · 5.0 MB");
	expect(frame).toContain("▣ After the fix · worker · 12:04Z · 1.2 MB");
	// The selected entry's metadata is the preview, since this terminal cannot
	// draw the image.
	expect(frame).toContain("▣ screenshot · 1.2 MB");
	expect(frame).toContain("recorded 2026-01-01T12:04:05.000Z");
	// The path is metadata on one line, so a long worktree truncates to the
	// column; the full path is what `y` copies.
	expect(frame).toContain("/repo/.herdr-workflow/evidence/wf-1/req-dbg-1/");
	t.renderer.destroy();
});

test("an empty manifest renders a neutral empty state", async () => {
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[]}
				active
				selectedIndex={0}
				kitty={false}
				height={8}
				state="ready"
			/>
		),
		{ width: 100, height: 16 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("No evidence attached yet"),
	);
	// No keybinding hints inside the panel body.
	expect(frame).not.toContain("Enter");
	expect(frame).not.toContain("press");
	t.renderer.destroy();
});

test("a read in flight and a failed read are not shown as an empty listing", async () => {
	const loading = await testRender(
		() => (
			<EvidencePanel
				entries={[]}
				active
				selectedIndex={0}
				kitty={false}
				height={8}
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
				selectedIndex={0}
				kitty={false}
				height={8}
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

test("without kitty graphics the panel shows metadata and never reads bytes", async () => {
	let reads = 0;
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={MANIFEST.entries}
				active
				selectedIndex={2}
				kitty={false}
				preview={() => {
					reads += 1;
					return PNG;
				}}
				height={12}
			/>
		),
		{ width: 140, height: 24 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("After the fix"),
	);
	expect(frame).toContain("▣ screenshot · 1.2 MB");
	// No image was mounted, so no half-block approximation was painted either.
	expect(frame).not.toMatch(/[\u2580-\u259f]/);
	expect(reads).toBe(0);
	t.renderer.destroy();
});

test("metadata longer than the panel says so instead of being cut off", async () => {
	// Eight metadata lines (kind/size, recorded, producer, app, url, poster,
	// caption, path) in a five-line body.
	const rich = entry({
		id: "01J000000000000000000000F",
		kind: "video",
		file: "req-dbg-2/01J000000000000000000000F.webm",
		caption: "repro video",
		step: "core.verification",
		app: "browser",
		url: "https://example.test/repro",
		poster: "01J000000000000000000000E",
		bytes: 5_000_000,
	});
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[rich]}
				active
				selectedIndex={0}
				kitty={false}
				path="/repo/.herdr-workflow/evidence/wf-1/req-dbg-2/01J000000000000000000000F.webm"
				height={6}
			/>
		),
		{ width: 140, height: 16 },
	);
	// The surplus is named rather than silently clipped.
	const frame = await t.waitForFrame((value) => value.includes("more lines"));
	expect(frame).toContain("▶ video");
	t.renderer.destroy();
});

test("a preview still in flight says so, and a settled one does not", async () => {
	const inFlight = await testRender(
		() => (
			<EvidencePanel
				entries={MANIFEST.entries}
				active
				selectedIndex={2}
				kitty
				preview={() => undefined}
				previewState="loading"
				height={12}
			/>
		),
		{ width: 140, height: 24 },
	);
	const loading = await inFlight.waitForFrame((value) =>
		value.includes("Loading preview…"),
	);
	// No image was mounted and the metadata is still painted beside the marker.
	expect(loading).not.toMatch(/[\u2580-\u259f]/);
	expect(loading).toContain("▣ screenshot · 1.2 MB");
	inFlight.renderer.destroy();

	const absent = await testRender(
		() => (
			<EvidencePanel
				entries={MANIFEST.entries}
				active
				selectedIndex={2}
				kitty
				preview={() => undefined}
				previewState="absent"
				height={12}
			/>
		),
		{ width: 140, height: 24 },
	);
	// A file the gateway answers as gone is an answer, not a pending read.
	const gone = await absent.waitForFrame((value) =>
		value.includes("Preview unavailable"),
	);
	expect(gone).not.toContain("Loading preview…");
	absent.renderer.destroy();

	const failed = await testRender(
		() => (
			<EvidencePanel
				entries={MANIFEST.entries}
				active
				selectedIndex={2}
				kitty
				preview={() => undefined}
				previewState="error"
				height={12}
			/>
		),
		{ width: 140, height: 24 },
	);
	await failed.waitForFrame((value) =>
		value.includes("Preview could not be read"),
	);
	failed.renderer.destroy();
});

test("an image with no room for it says so instead of drawing a strip", async () => {
	// Five metadata lines in a seven-line body leave two rows: not enough for a
	// picture, so the row that is left says why.
	const long = entry({
		id: "01J000000000000000000000G",
		caption: "a long caption",
		step: "core.verification",
		role: "worker",
		app: "browser",
	});
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[long]}
				active
				selectedIndex={0}
				kitty
				preview={() => PNG}
				previewState="ready"
				height={8}
			/>
		),
		{ width: 140, height: 16 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("Preview too small"),
	);
	expect(frame).not.toMatch(/[\u2580-\u259f]/);
	t.renderer.destroy();
});

test("metadata that fills the panel keeps its last line, with no message row", async () => {
	// Six metadata lines (kind/size, recorded, producer, app, caption, path) in a
	// six-line body: the message row is not painted, so nothing is clipped.
	const filled = entry({
		id: "01J000000000000000000000H",
		caption: "a caption",
		step: "core.verification",
		role: "worker",
		app: "browser",
	});
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[filled]}
				active
				selectedIndex={0}
				kitty
				preview={() => PNG}
				previewState="ready"
				path="/repo/.herdr-workflow/evidence/wf-1/01J000000000000000000000H.png"
				height={7}
			/>
		),
		{ width: 140, height: 16 },
	);
	const frame = await t.waitForFrame((value) => value.includes("a caption"));
	expect(frame).toContain("/repo/.herdr-workflow/evidence/wf-1/");
	expect(frame).not.toContain("Preview too small");
	expect(frame).not.toContain("Loading preview…");
	t.renderer.destroy();
});

test("metadata longer than the panel keeps its marker inside the body", async () => {
	// Seven metadata lines in a five-line body: four lines plus the marker.
	const rich = entry({
		id: "01J000000000000000000000I",
		kind: "video",
		file: "req-dbg-2/01J000000000000000000000I.webm",
		caption: "repro video",
		step: "core.verification",
		app: "browser",
		url: "https://example.test/repro",
		poster: "01J000000000000000000000E",
		bytes: 5_000_000,
	});
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[rich]}
				active
				selectedIndex={0}
				kitty={false}
				height={6}
			/>
		),
		{ width: 140, height: 16 },
	);
	const frame = await t.waitForFrame((value) => value.includes("more lines"));
	expect(frame).toContain("… 3 more lines");
	t.renderer.destroy();
});

test("a failed refresh marks the listing that is already on screen", async () => {
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={MANIFEST.entries}
				active
				selectedIndex={2}
				kitty={false}
				state="error"
				error="the transport dropped"
				height={12}
			/>
		),
		{ width: 140, height: 24 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("last read failed"),
	);
	// The last-known listing stays visible, and it is marked as stale.
	expect(frame).toContain("After the fix");
	t.renderer.destroy();
});

test("with kitty graphics the panel mounts the image and still paints the metadata", async () => {
	let reads = 0;
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={MANIFEST.entries}
				active
				selectedIndex={2}
				kitty
				preview={() => {
					reads += 1;
					return PNG;
				}}
				path="/repo/.herdr-workflow/evidence/wf-1/req-dbg-1/01J000000000000000000000C.png"
				height={11}
			/>
		),
		{ width: 140, height: 24 },
	);
	await t.waitForFrame((value) => value.includes("After the fix"));
	// The image box read the bytes; the metadata stays under it.
	expect(reads).toBeGreaterThan(0);
	// The image takes what the metadata does not need, so the caption and the
	// path are painted instead of being clipped away silently.
	const frame = t.captureCharFrame();
	expect(frame).toContain("After the fix");
	expect(frame).toContain("/repo/.herdr-workflow/evidence/wf-1/req-dbg-1/");
	t.renderer.destroy();
});
