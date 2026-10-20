// The Evidence panel's own keys (`add-dashboard-evidence-panel`, task 3.1).
//
// `Enter` opens the row the panel highlights, `y` copies that same row's path,
// and `j`/`k` move that panel's selection — all inside the one row index space
// the panel paints (`evidenceRows`: newest first, grouped), never the manifest's
// own order. The handler takes every action as an injected callback, so these
// assertions need no renderer and launch no real opener.
import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { EvidenceEntry } from "../../src/contracts/environment.ts";
import type { StageJournal } from "../../src/contracts/stages.ts";
import { testDashboard } from "../../src/tui/dash/demo.ts";
import { evidenceRows } from "../../src/tui/dash/evidence-panel.ts";
import {
	createDashboardKeyHandler,
	type DashboardKeyContext,
} from "../../src/tui/dash/handlers/keys.ts";
import { EVIDENCE_PANEL } from "../../src/tui/dash/panel-grid.ts";

function entry(id: string, caption: string): EvidenceEntry {
	return {
		id,
		kind: "screenshot",
		file: `${id}.png`,
		caption,
		createdAt: "2026-01-01T12:04:05.000Z",
		bytes: 1234,
	};
}

const OLDEST = entry("01J000000000000000000000A", "oldest");
const MIDDLE = entry("01J000000000000000000000B", "middle");
const NEWEST = entry("01J000000000000000000000C", "newest");
/** The manifest's own order, which the panel does not paint. */
const MANIFEST = [OLDEST, MIDDLE, NEWEST];

function keyEvent(name: string, shift = false): KeyEvent {
	return { name, shift, ctrl: false, meta: false } as unknown as KeyEvent;
}

function harness(rows: ReturnType<typeof evidenceRows>) {
	const opened: EvidenceEntry[] = [];
	const copied: EvidenceEntry[] = [];
	const moved: number[] = [];
	const otherPanels: string[] = [];
	const notified: string[] = [];
	let flowOpened = 0;
	let selected = 0;
	const keymap = { getData: () => "none", setData: () => {} };
	const context = {
		keymap,
		renderer: { getSelection: () => null, destroy: () => {} },
		busy: () => false,
		activePanel: () => EVIDENCE_PANEL,
		setActivePanel: () => {},
		refresh: () => {},
		selectedAgent: () => 0,
		setSelectedAgent: () => otherPanels.push("agent"),
		selectedArtifact: () => 0,
		setSelectedArtifact: () => otherPanels.push("artifact"),
		selectedDecision: () => 0,
		setSelectedDecision: () => otherPanels.push("decision"),
		selectedEvidence: () => selected,
		setSelectedEvidence: (index: number) => {
			selected = index;
			moved.push(index);
		},
		evidenceRows: () => rows,
		openEvidence: (item: EvidenceEntry) => opened.push(item),
		copyEvidencePath: (item: EvidenceEntry) => copied.push(item),
		openEvidenceFlow: () => {
			flowOpened += 1;
		},
		artifacts: () => [],
		data: () => testDashboard(),
		dimensions: () => ({ width: 120, height: 40 }),
		notify: (message: string) => notified.push(message),
		trace: () => {},
		routeModalHelp: () => false,
		props: { repo: "/repo", workflowId: "wf-1", keymap },
		openRequiredUserAction: () => false,
		gate: () => undefined,
	} as unknown as DashboardKeyContext;
	return {
		handle: createDashboardKeyHandler(context),
		opened,
		copied,
		moved,
		notified,
		flowOpened: () => flowOpened,
		otherPanels,
		selected: () => selected,
	};
}

describe("the Evidence panel's keys", () => {
	test("Enter opens the painted row, not the manifest's own first entry", async () => {
		const rows = evidenceRows(MANIFEST);
		// The panel paints newest first, so the top row is the manifest's last
		// entry: reading the manifest by index would open a different file.
		expect(rows.map((row) => row.entry?.id)).toEqual([
			NEWEST.id,
			MIDDLE.id,
			OLDEST.id,
		]);

		const first = harness(rows);
		await first.handle(keyEvent("enter"));
		expect(first.opened.map((item) => item.id)).toEqual([NEWEST.id]);

		// The same holds for a row further down the list.
		const third = harness(rows);
		await third.handle(keyEvent("j"));
		await third.handle(keyEvent("j"));
		await third.handle(keyEvent("enter"));
		expect(third.moved).toEqual([1, 2]);
		expect(third.opened.map((item) => item.id)).toEqual([OLDEST.id]);
	});

	test("y copies the painted row's path", async () => {
		const rows = evidenceRows(MANIFEST);
		const { handle, copied } = harness(rows);
		await handle(keyEvent("j"));
		await handle(keyEvent("y"));
		expect(copied.map((item) => item.id)).toEqual([MIDDLE.id]);
	});

	test("Enter and y do nothing when there is no row to act on", async () => {
		const { handle, opened, copied } = harness([]);
		await handle(keyEvent("enter"));
		await handle(keyEvent("y"));
		expect(opened).toEqual([]);
		expect(copied).toEqual([]);
	});

	test("Enter on a stage flow step row opens the flow page, and y says why it copied nothing", async () => {
		// A journal step names no file of its own, so the two keys that act on a file
		// act on the page the step is written into instead — and the copy key says so
		// rather than looking broken on the row it was pressed on.
		const journal: StageJournal = {
			workflowId: "wf-flow",
			entries: [
				{
					seq: 1,
					at: "2026-01-01T12:00:00.000Z",
					session: "default",
					label: "open the cart",
					segment: 1,
					offsetMs: 2_000,
				},
			],
			flowPage: "stage-flow.html",
		};
		const stepRows = evidenceRows([], journal);
		expect(stepRows[0]?.step?.label).toBe("open the cart");
		const { handle, opened, copied, notified, flowOpened } = harness(stepRows);
		await handle(keyEvent("enter"));
		expect(flowOpened()).toBe(1);
		expect(opened).toEqual([]);
		await handle(keyEvent("y"));
		expect(copied).toEqual([]);
		expect(notified[0]).toContain("no file of its own");
	});

	test("j and k move the selection within the rows and stop at both ends", async () => {
		const { handle, moved, selected } = harness(evidenceRows(MANIFEST));
		await handle(keyEvent("j"));
		await handle(keyEvent("j"));
		await handle(keyEvent("j"));
		expect(selected()).toBe(2);
		await handle(keyEvent("k"));
		await handle(keyEvent("k"));
		await handle(keyEvent("k"));
		expect(selected()).toBe(0);
		expect(moved).toEqual([1, 2, 2, 1, 0, 0]);
	});

	test("evidence navigation never moves another panel's selection", async () => {
		const { handle, otherPanels } = harness(evidenceRows(MANIFEST));
		await handle(keyEvent("j"));
		await handle(keyEvent("k"));
		await handle(keyEvent("enter"));
		await handle(keyEvent("y"));
		expect(otherPanels).toEqual([]);
	});
});
