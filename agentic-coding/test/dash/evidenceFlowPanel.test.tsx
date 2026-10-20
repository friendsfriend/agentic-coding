/** @jsxImportSource @opentui/solid */
// The Evidence panel's stage flow grouping (`add-stage-flow-evidence`, task 3.1).
//
// A workflow that recorded a stage flow lists it by recording segment: each
// segment's heading, the journal steps written during it with their offsets, and
// the evidence those steps reference. A workflow without a journal keeps the
// grouping it always had, which is the point of the journal being optional.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testRender } from "@opentui/solid";
import type { EvidenceEntry } from "../../src/contracts/environment.ts";
import type {
	StageJournal,
	StageJournalEntry,
} from "../../src/contracts/stages.ts";
import {
	evidenceOpenRequest,
	openStageFlowExternally,
	stageFlowPath,
} from "../../src/tui/dash/evidence-open.ts";
import {
	EVIDENCE_EMPTY_LINES,
	EVIDENCE_PANEL_LINES,
	evidencePanelLines,
	evidenceRows,
	evidenceStepDetailLines,
} from "../../src/tui/dash/evidence-panel.ts";
import {
	dashboardDetailKeybindCatalog,
	EVIDENCE_PANEL_CONTEXT,
} from "../../src/tui/dash/keybinds.ts";
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

const SHOT = entry({
	id: "01J000000000000000000000A",
	caption: "empty cart",
});
const VIDEO = entry({
	id: "01J000000000000000000000B",
	kind: "video",
	file: "01J000000000000000000000B.webm",
	caption: "checkout flow",
	segment: 1,
	poster: "01J000000000000000000000C",
	bytes: 5_000_000,
});
const POSTER = entry({
	id: "01J000000000000000000000C",
	file: "01J000000000000000000000C.jpg",
	caption: "checkout flow (final frame)",
	bytes: 999,
});
/** Attached outside any segment: a second flow, or a picture taken before the
 * recording started. */
const LOOSE = entry({
	id: "01J000000000000000000000D",
	caption: "the login page",
});

const FIRST: StageJournalEntry = {
	seq: 1,
	at: "2026-01-01T12:00:00.000Z",
	session: "default",
	app: "web",
	role: "clerk",
	url: "https://grid.example.test/cart",
	label: "open the cart",
	expected: "cart is empty",
	observed: "cart is empty",
	segment: 1,
	offsetMs: 2_000,
	evidence: [SHOT.id],
	video: VIDEO.id,
};
const SECOND: StageJournalEntry = {
	seq: 2,
	at: "2026-01-01T12:00:30.000Z",
	session: "default",
	app: "web",
	label: "checkout",
	captures: { total: "0.00 EUR" },
	segment: 1,
	offsetMs: 65_000,
	video: VIDEO.id,
};
const WITHOUT_SEGMENT: StageJournalEntry = {
	seq: 3,
	at: "2026-01-01T12:10:00.000Z",
	label: "sign in",
	evidence: [LOOSE.id],
};

const JOURNAL: StageJournal = {
	workflowId: "wf-flow",
	entries: [FIRST, SECOND, WITHOUT_SEGMENT],
	flowPage: "stage-flow.html",
};

test("a journal groups the listing by segment, with its steps before its evidence", () => {
	const rows = evidenceRows([SHOT, VIDEO, POSTER, LOOSE], JOURNAL);
	expect(rows.map((row) => [row.header ?? "", row.label])).toEqual([
		[
			"Segment 1 · checkout flow · 12:04Z · 5.0 MB",
			"› 00:02 open the cart · web/clerk",
		],
		["", "› 01:05 checkout · web"],
		// Inside a segment the evidence keeps the panel's own order: newest first.
		["", "▣ checkout flow (final frame) · 12:04Z · 999 B"],
		["", "▶ checkout flow · 12:04Z · 5.0 MB"],
		["", "▣ empty cart · 12:04Z · 1.2 KB"],
		["Unreferenced", "› sign in"],
		["", "▣ the login page · 12:04Z · 1.2 KB"],
	]);
	// The step rows carry the step and no file; the evidence rows the entry.
	expect(rows[0]?.step?.seq).toBe(1);
	expect(rows[0]?.entry).toBeUndefined();
	expect(rows[2]?.entry?.id).toBe(POSTER.id);
	expect(rows[2]?.step).toBeUndefined();
	// The poster is filed with the segment its video belongs to, even though the
	// entry itself names no segment.
	expect(rows[4]?.entry?.id).toBe(SHOT.id);
});

test("a step's detail lines say where it ran and what it saw", () => {
	expect(evidenceStepDetailLines(FIRST)).toEqual([
		"00:02 · web / clerk",
		"https://grid.example.test/cart",
		"expected cart is empty",
		"observed cart is empty",
	]);
	expect(evidenceStepDetailLines(SECOND)).toEqual([
		"01:05 · web",
		"total 0.00 EUR",
	]);
	// A step that never ran inside a recording says so rather than showing a
	// zero offset it does not have.
	expect(evidenceStepDetailLines(WITHOUT_SEGMENT)).toEqual(["step"]);
});

test("a workflow without a journal keeps the debug-request grouping", () => {
	const rows = evidenceRows([SHOT, VIDEO, POSTER, LOOSE]);
	expect(rows.some((row) => row.step !== undefined)).toBe(false);
	expect(rows.map((row) => row.entry?.id)).toEqual([
		LOOSE.id,
		POSTER.id,
		VIDEO.id,
		SHOT.id,
	]);
});

test("the open-flow keybind is offered only where a flow page exists", () => {
	const keys = (flow: boolean) =>
		dashboardDetailKeybindCatalog({
			artifactsVisible: true,
			evidenceFlow: flow,
		})
			.flatMap((section) => section.keybinds)
			.filter((keybind) => keybind.context === EVIDENCE_PANEL_CONTEXT)
			.map((keybind) => keybind.key);
	expect(keys(true)).toContain("f");
	// A workflow that recorded no step has no page to open, so the footer and the
	// help modal do not advertise a key that would do nothing.
	expect(keys(false)).not.toContain("f");
});

test("the flow page is opened by the path the evidence store composes", async () => {
	const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "flow-open-"));
	const state = {
		workflowId: "wf-flow",
		worktree,
		definition: {
			id: "core",
			version: 1,
			digest: "d1",
			label: "Core",
		},
	};
	const file = stageFlowPath(state, "stage-flow.html");
	expect(file).toBe(
		`${worktree}/.herdr-workflow/evidence/wf-flow/stage-flow.html`,
	);
	// A name the store would not have written is refused rather than composed into
	// a path outside the evidence root.
	expect(stageFlowPath(state, "../manifest.json")).toBeUndefined();

	// A page that is not on this machine is refused instead of being handed to an
	// opener that would fail silently.
	const opened: string[] = [];
	const opener = async (request: { args: readonly string[] }) => {
		opened.push(...request.args);
		return { mode: "local" as const, status: 0 };
	};
	await expect(
		openStageFlowExternally(state, "stage-flow.html", opener),
	).rejects.toThrow();
	expect(opened).toEqual([]);

	// Once the page is there, the system opener receives exactly that file.
	if (file !== undefined) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "<!doctype html>");
	}
	await openStageFlowExternally(state, "stage-flow.html", opener);
	expect(opened).toEqual([file as string]);
	// One evidence file's own opener composes the same address family.
	expect(evidenceOpenRequest(state, SHOT).args).toContain(
		`${worktree}/.herdr-workflow/evidence/wf-flow/${SHOT.file}`,
	);
});

test("the rendered panel shows the segment, its steps and their detail", async () => {
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[SHOT, VIDEO, POSTER, LOOSE]}
				journal={JOURNAL}
				active
				selectedIndex={0}
				kitty={false}
				height={EVIDENCE_PANEL_LINES + 6}
				state="ready"
			/>
		),
		{ width: 120, height: 24 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("open the cart"),
	);
	expect(frame).toContain("Segment 1");
	expect(frame).toContain("00:02 open the cart");
	expect(frame).toContain("expected cart is empty");
	expect(frame).toContain("Unreferenced");
	t.renderer.destroy();
});

test("a workflow whose journal holds only steps still lists them", async () => {
	// The height is the painted row count, not the manifest's: a journal-only flow
	// has no evidence file at all, and the empty state's one title row would clip
	// the very listing the journal was written for.
	expect(
		evidencePanelLines({ rows: 3, state: "ready", terminalLines: 40 }),
	).toBe(EVIDENCE_PANEL_LINES);
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[]}
				journal={{
					workflowId: "wf-flow",
					entries: [FIRST, SECOND],
					flowPage: "stage-flow.html",
				}}
				active
				selectedIndex={0}
				kitty={false}
				height={evidencePanelLines({
					rows: 2,
					state: "ready",
					terminalLines: 40,
				})}
				state="ready"
			/>
		),
		{ width: 120, height: 24 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("00:02 open the cart"),
	);
	expect(frame).not.toContain("No evidence attached yet");
	expect(frame).toContain("Segment 1");
	t.renderer.destroy();
});

test("a collapsed panel says how many rows it has no room for", async () => {
	const t = await testRender(
		() => (
			<EvidencePanel
				entries={[]}
				journal={JOURNAL}
				active
				selectedIndex={0}
				kitty={false}
				height={EVIDENCE_EMPTY_LINES}
				state="ready"
			/>
		),
		{ width: 120, height: 8 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("rows, no room"),
	);
	const rows = frame.split("\n");
	// One title row, and the accessory says the listing exists rather than that the
	// workflow recorded nothing.
	expect(rows[0]).toContain("Evidence");
	expect(rows[0]).toContain(
		`${evidenceRows([], JOURNAL).length} rows, no room`,
	);
	expect(frame).not.toContain("No evidence attached yet");
	t.renderer.destroy();
});
