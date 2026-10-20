// The Evidence panel's and subview's keys (`evidence-summary-subview`, task 4.3).
//
// The panel is a summary, so its whole key surface is one action: `Enter` opens
// the evidence subview. Everything that acts on a row — `Enter` opening the
// highlighted entry, `y` copying its path, `j`/`k` moving the selection, `f`
// opening the flow page, the report's scroll — lives in the subview, and it acts
// inside the one row index space the sidebar paints (`evidenceRows`: newest first
// and grouped), never the manifest's own order. Both handlers take every action as
// an injected callback, so these assertions need no renderer and launch no real
// opener.
import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { EvidenceEntry } from "../../src/contracts/environment.ts";
import type { StageJournal } from "../../src/contracts/stages.ts";
import { testDashboard } from "../../src/tui/dash/demo.ts";
import { evidenceRows } from "../../src/tui/dash/evidence-panel.ts";
import {
	createDashboardKeyHandler,
	createEvidenceSubviewKeyHandler,
	type DashboardKeyContext,
	type EvidenceSubviewKeyContext,
} from "../../src/tui/dash/handlers/keys.ts";
import { AGENTS_PANEL, EVIDENCE_PANEL } from "../../src/tui/dash/panel-grid.ts";

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
/** The manifest's own order, which the sidebar does not paint. */
const MANIFEST = [OLDEST, MIDDLE, NEWEST];

function keyEvent(name: string, shift = false, ctrl = false): KeyEvent {
	return { name, shift, ctrl, meta: false } as unknown as KeyEvent;
}

function harness(activePanel: number = EVIDENCE_PANEL) {
	const moved: number[] = [];
	const otherPanels: string[] = [];
	const notified: string[] = [];
	const selected = 0;
	const keymap = { getData: () => "none", setData: () => {} };
	const context = {
		keymap,
		renderer: { getSelection: () => null, destroy: () => {} },
		busy: () => false,
		activePanel: () => activePanel,
		setActivePanel: () => {},
		refresh: () => {},
		selectedAgent: () => 0,
		setSelectedAgent: () => otherPanels.push("agent"),
		selectedArtifact: () => 0,
		setSelectedArtifact: () => otherPanels.push("artifact"),
		selectedDecision: () => 0,
		setSelectedDecision: () => otherPanels.push("decision"),
		openEvidenceView: () => {
			openedViews += 1;
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
	let openedViews = 0;
	return {
		handle: createDashboardKeyHandler(context),
		moved,
		notified,
		views: () => openedViews,
		otherPanels,
		selected: () => selected,
	};
}

/** The subview's own handler, over the same row list and a real-ish selection. */
function subview(
	rows: ReturnType<typeof evidenceRows>,
	options: { selected?: number; scroll?: boolean } = {},
) {
	const opened: EvidenceEntry[] = [];
	const copied: EvidenceEntry[] = [];
	const moved: number[] = [];
	const notified: string[] = [];
	const scrolls: number[] = [];
	let flowOpened = 0;
	let closed = 0;
	let selected = options.selected ?? 0;
	const context: EvidenceSubviewKeyContext = {
		rows: () => rows,
		selectedIndex: () => selected,
		setSelectedIndex: (index) => {
			selected = index;
			moved.push(index);
		},
		reportScroll: () =>
			options.scroll === false
				? undefined
				: {
						scrollBy: (lines: number) => {
							scrolls.push(lines);
						},
					},
		dimensions: () => ({ width: 120, height: 30 }),
		openEvidence: (item) => opened.push(item),
		copyEvidencePath: (item) => copied.push(item),
		openEvidenceFlow: () => {
			flowOpened += 1;
		},
		close: () => {
			closed += 1;
		},
		notify: (message) => notified.push(message),
	};
	return {
		handle: createEvidenceSubviewKeyHandler(context),
		opened,
		copied,
		moved,
		notified,
		scrolls,
		flowOpened: () => flowOpened,
		closed: () => closed,
		selected: () => selected,
	};
}

const STEP_JOURNAL: StageJournal = {
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

describe("the Evidence panel's keys", () => {
	test("Enter opens the evidence view", async () => {
		const { handle, views } = harness();
		await handle(keyEvent("enter"));
		expect(views()).toBe(1);
	});

	test("the panel no longer acts on rows itself", async () => {
		// `y`, `f`, `j` and `k` belong to the subview now: the panel is a summary
		// with no selection of its own to move or act on. The dashboard context has
		// no row actions at all, so the real assertion is that none of these keys
		// opens the view, moves a panel or says anything.
		const { handle, views, otherPanels, notified, moved } = harness();
		for (const name of ["y", "f", "j", "k", "down", "up"]) {
			await handle(keyEvent(name));
		}
		expect(views()).toBe(0);
		expect(moved).toEqual([]);
		expect(notified).toEqual([]);
		expect(otherPanels).toEqual([]);
	});

	test("another panel's Enter is not the evidence view's", async () => {
		const { handle, views } = harness(AGENTS_PANEL);
		await handle(keyEvent("enter"));
		expect(views()).toBe(0);
	});
});

describe("the evidence subview's keys", () => {
	test("Enter opens the painted row, not the manifest's own first entry", () => {
		const rows = evidenceRows(MANIFEST);
		// The sidebar paints newest first, so the top row is the manifest's last
		// entry: reading the manifest by index would open a different file.
		expect(rows.map((row) => row.entry?.id)).toEqual([
			NEWEST.id,
			MIDDLE.id,
			OLDEST.id,
		]);

		const first = subview(rows);
		expect(first.handle(keyEvent("enter"))).toBe(true);
		expect(first.opened.map((item) => item.id)).toEqual([NEWEST.id]);

		// The same holds for a row further down the list.
		const third = subview(rows);
		third.handle(keyEvent("j"));
		third.handle(keyEvent("j"));
		third.handle(keyEvent("enter"));
		expect(third.moved).toEqual([1, 2]);
		expect(third.opened.map((item) => item.id)).toEqual([OLDEST.id]);
	});

	test("y copies the painted row's path", () => {
		const { handle, copied } = subview(evidenceRows(MANIFEST));
		handle(keyEvent("j"));
		handle(keyEvent("y"));
		expect(copied.map((item) => item.id)).toEqual([MIDDLE.id]);
	});

	test("Enter and y say there is no row to act on", () => {
		// The page is reachable from an empty manifest, and `f` already answers on
		// it: the two row keys say the same rather than acting as dead keys.
		const { handle, opened, copied, notified } = subview([]);
		handle(keyEvent("enter"));
		handle(keyEvent("y"));
		expect(opened).toEqual([]);
		expect(copied).toEqual([]);
		expect(notified).toEqual(["No evidence selected", "No evidence selected"]);
	});

	test("Enter on a stage flow step row opens the flow page, and y says why it copied nothing", () => {
		// A journal step names no file of its own, so the two keys that act on a file
		// act on the page the step is written into instead — and the copy key says so
		// rather than looking broken on the row it was pressed on.
		const stepRows = evidenceRows([], STEP_JOURNAL);
		expect(stepRows[0]?.step?.label).toBe("open the cart");
		const { handle, opened, copied, notified, flowOpened } = subview(stepRows);
		handle(keyEvent("enter"));
		expect(flowOpened()).toBe(1);
		expect(opened).toEqual([]);
		handle(keyEvent("y"));
		expect(copied).toEqual([]);
		// The message holds for a step in a kept segment *and* for one that has none:
		// it names what always exists (the flow page) instead of "the segment's rows",
		// which two of the three groupings do not show.
		expect(notified[0]).toContain("names no file");
		expect(notified[0]).toContain("press f");
	});

	test("y on a step without a segment says the same thing", () => {
		const journal: StageJournal = {
			workflowId: "wf-flow",
			entries: [
				{
					seq: 1,
					at: "2026-01-01T12:00:00.000Z",
					session: "default",
					label: "before recording",
				},
				{
					seq: 2,
					at: "2026-01-01T12:01:00.000Z",
					session: "default",
					label: "inside a segment",
					segment: 1,
					offsetMs: 1_000,
				},
			],
			flowPage: "stage-flow.html",
		};
		const rows = evidenceRows([], journal);
		expect(rows.every((row) => row.step !== undefined)).toBe(true);
		for (const index of [0, 1]) {
			const { handle, copied, notified } = subview(rows, { selected: index });
			handle(keyEvent("y"));
			expect(copied).toEqual([]);
			expect(notified[0]).toContain("names no file");
		}
	});

	test("f opens the flow page", () => {
		const { handle, flowOpened, opened } = subview(evidenceRows(MANIFEST), {
			selected: 1,
		});
		handle(keyEvent("f"));
		expect(flowOpened()).toBe(1);
		// The action is the page's, never a file's.
		expect(opened).toEqual([]);
	});

	test("j and k move the selection within the rows and stop at both ends", () => {
		const { handle, moved, selected } = subview(evidenceRows(MANIFEST));
		handle(keyEvent("j"));
		handle(keyEvent("j"));
		handle(keyEvent("j"));
		expect(selected()).toBe(2);
		handle(keyEvent("k"));
		handle(keyEvent("k"));
		handle(keyEvent("k"));
		expect(selected()).toBe(0);
		expect(moved).toEqual([1, 2, 2, 1, 0, 0]);
	});

	test("the arrow keys move the selection like j and k", () => {
		const { handle, selected } = subview(evidenceRows(MANIFEST));
		handle(keyEvent("down"));
		expect(selected()).toBe(1);
		handle(keyEvent("up"));
		handle(keyEvent("up"));
		expect(selected()).toBe(0);
	});

	test("the report scrolls by a page on PgUp/PgDn and Ctrl+U/Ctrl+D", () => {
		const { handle, scrolls } = subview(evidenceRows(MANIFEST));
		handle(keyEvent("pageup"));
		handle(keyEvent("pagedown"));
		handle(keyEvent("u", false, true));
		handle(keyEvent("d", false, true));
		// A page is a third of the terminal, never a whole one: the reader keeps
		// their place at the pane's edge.
		expect(scrolls).toEqual([-10, 10, -10, 10]);
	});

	test("a scroll key claimed with no report box does nothing else", () => {
		// The view has not painted its box yet: the key is still the page's, so it
		// cannot fall through and scroll some other panel under the page.
		const { handle, moved, opened } = subview(evidenceRows(MANIFEST), {
			scroll: false,
		});
		expect(handle(keyEvent("pagedown"))).toBe(true);
		expect(moved).toEqual([]);
		expect(opened).toEqual([]);
	});

	test("Esc leaves the view", () => {
		const { handle, closed, opened } = subview(evidenceRows(MANIFEST));
		expect(handle(keyEvent("escape"))).toBe(true);
		expect(closed()).toBe(1);
		expect(opened).toEqual([]);
	});

	test("a key the page does not declare falls through to the shell", () => {
		const { handle, moved, opened } = subview(evidenceRows(MANIFEST));
		expect(handle(keyEvent("?"))).toBe(false);
		expect(moved).toEqual([]);
		expect(opened).toEqual([]);
	});

	test("evidence navigation never moves another panel's selection", () => {
		const { handle, otherPanels } = harness();
		handle(keyEvent("enter"));
		const page = subview(evidenceRows(MANIFEST));
		page.handle(keyEvent("j"));
		page.handle(keyEvent("k"));
		page.handle(keyEvent("enter"));
		page.handle(keyEvent("y"));
		expect(otherPanels).toEqual([]);
	});
});
