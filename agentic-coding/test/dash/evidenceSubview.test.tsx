/** @jsxImportSource @opentui/solid */
// The evidence subview (`evidence-summary-subview`, task 4.1).
//
// One page, two panes: the run's report on the left and every evidence entry on
// the right. The assertions below cover what a reader actually gets — the report
// rendered from markdown with its citations resolved, a cited screenshot only
// mounted where the renderer can draw one, the whole manifest listed even when no
// report exists, the flow grouping kept when the workflow recorded a journal, and
// the pointer wiring the panel used to own.
import { expect, test } from "bun:test";
import { setRendererCapabilities } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { EvidenceEntry } from "../../src/contracts/environment.ts";
import type {
	StageJournal,
	StageJournalEntry,
} from "../../src/contracts/stages.ts";
import {
	type EvidenceListRow,
	evidenceRowLabel,
} from "../../src/tui/dash/evidence-panel.ts";
import {
	type EvidenceReportState,
	EvidenceSubview,
} from "../../src/tui/dash/ui/EvidenceSubview.tsx";

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

const SHOT = entry({ id: "01J000000000000000000000A", caption: "empty cart" });
const CITED = entry({
	id: "01J000000000000000000000B",
	caption: "checkout",
	bytes: 2048,
});
/** Never cited by a report, so it is only ever a sidebar row. */
const LOOSE = entry({
	id: "01J000000000000000000000C",
	kind: "log",
	file: "01J000000000000000000000C.log",
	caption: "run log",
});
const ENTRIES = [SHOT, CITED, LOOSE];

type Render = Awaited<ReturnType<typeof testRender>>;

/**
 * Wait until a frame's *content* satisfies the predicate.
 *
 * The renderer's own `waitForFrame` gives up as soon as its scheduler reports
 * idle, and this pane's markdown is painted by an asynchronous pass the scheduler
 * does not account for: the wait could break before the paint landed and report a
 * timeout for a page that is about to be correct (that is the flake it was
 * reported as). Polling in real time with a render forced between attempts waits
 * for the paint itself.
 */
async function frameWith(
	t: Render,
	predicate: (frame: string) => boolean,
	describe: string,
	attempts = 200,
): Promise<string> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const frame = t.captureCharFrame();
		if (predicate(frame)) return frame;
		await new Promise((resolve) => setTimeout(resolve, 5));
		await t.renderOnce();
	}
	throw new Error(`the evidence page never painted ${describe}`);
}

const REPORT = [
	"# Run report",
	"",
	`The cart was empty [^${SHOT.id}].`,
	"",
	"## After the fix",
	"",
	`Checkout works [^${CITED.id}].`,
].join("\n");

function subview(props: {
	entries?: readonly EvidenceEntry[];
	journal?: StageJournal;
	report?: string;
	reportState?: EvidenceReportState;
	reportError?: string;
	kitty?: boolean;
	images?: () => Readonly<Record<string, Uint8Array>>;
	selectedIndex?: number;
	pathOf?: (entry: EvidenceEntry) => string | undefined;
	state?: "loading" | "ready" | "error";
	error?: string;
	rows?: () => EvidenceListRow[];
	onSelectIndex?: (index: number) => void;
	onActivateRow?: (index: number) => void;
}) {
	const reportState = props.reportState ?? "ready";
	return (
		<EvidenceSubview
			entries={props.entries ?? ENTRIES}
			{...(props.journal === undefined ? {} : { journal: props.journal })}
			report={() => props.report}
			reportState={reportState}
			{...(props.reportError === undefined
				? {}
				: { reportError: props.reportError })}
			{...(props.state === undefined ? {} : { state: props.state })}
			{...(props.error === undefined ? {} : { error: props.error })}
			{...(props.rows === undefined ? {} : { rows: props.rows })}
			kitty={props.kitty ?? false}
			{...(props.images === undefined ? {} : { images: props.images })}
			selectedIndex={props.selectedIndex ?? 0}
			{...(props.pathOf === undefined ? {} : { pathOf: props.pathOf })}
			{...(props.onSelectIndex === undefined
				? {}
				: { onSelectIndex: props.onSelectIndex })}
			{...(props.onActivateRow === undefined
				? {}
				: { onActivateRow: props.onActivateRow })}
		/>
	);
}

test("the report renders beside every entry of the manifest", async () => {
	const t = await testRender(() => subview({ report: REPORT }), {
		width: 140,
		height: 30,
	});
	const frame = await frameWith(
		t,
		(value) => value.includes("The cart was empty"),
		"the report body",
	);
	// The report's own markdown: headings and prose, rendered by the shared
	// renderer rather than shown as source.
	expect(frame).toContain("Run report");
	expect(frame).toContain("After the fix");
	expect(frame).toContain("Checkout works");
	// Every entry is listed, cited or not, and the pane counts them.
	expect(frame).toContain("empty cart");
	expect(frame).toContain("checkout");
	expect(frame).toContain("run log");
	expect(frame).toContain("3 entries");
	// The trailing sources list names what the report cited.
	expect(frame).toContain("sources");
	t.renderer.destroy();
});

test("a citation the manifest does not hold is visibly broken, not fatal", async () => {
	const report = `See [^01J000000000000000000000Z] and [^${SHOT.id}].`;
	const t = await testRender(() => subview({ report }), {
		width: 140,
		height: 30,
	});
	const frame = await frameWith(
		t,
		(value) => value.includes("unknown evidence"),
		"the broken citation",
	);
	// The body renders, the unknown id says what it is, and the sources list
	// carries it as a row the reader can act on.
	expect(frame).toContain("See");
	expect(frame).toContain("[^01J000000000000000000000Z");
	expect(frame).toContain("sources");
	expect(frame).toContain("not in this manifest");
	t.renderer.destroy();
});

test("a run that attached no report still lists the whole manifest", async () => {
	const t = await testRender(() => subview({ reportState: "none" }), {
		width: 120,
		height: 24,
	});
	const frame = await t.waitForFrame((value) =>
		value.includes("No report attached"),
	);
	// The report pane's fact is not an empty page: the sidebar is intact.
	expect(frame).toContain("empty cart");
	expect(frame).toContain("run log");
	t.renderer.destroy();
});

test("a report in flight, gone, or failed is each its own answer", async () => {
	const loading = await testRender(() => subview({ reportState: "loading" }), {
		width: 120,
		height: 24,
	});
	const loadingFrame = await loading.waitForFrame((value) =>
		value.includes("Loading report…"),
	);
	expect(loadingFrame).not.toContain("No report attached");
	loading.renderer.destroy();

	const absent = await testRender(() => subview({ reportState: "absent" }), {
		width: 120,
		height: 24,
	});
	const absentFrame = await absent.waitForFrame((value) =>
		value.includes("The report file is not on this machine."),
	);
	expect(absentFrame).not.toContain("Loading report…");
	expect(absentFrame).not.toContain("No report attached");
	absent.renderer.destroy();

	const failed = await testRender(
		() => subview({ reportState: "error", reportError: "the read failed" }),
		{ width: 120, height: 24 },
	);
	const failedFrame = await failed.waitForFrame((value) =>
		value.includes("The report could not be read: the read failed"),
	);
	expect(failedFrame).not.toContain("No report attached");
	failed.renderer.destroy();
});

test("without kitty graphics a cited screenshot keeps its caption and path", async () => {
	let reads = 0;
	const t = await testRender(
		() =>
			subview({
				report: REPORT,
				pathOf: (item) => `/repo/evidence/${item.file}`,
				images: () => {
					reads += 1;
					return {};
				},
			}),
		{ width: 140, height: 30 },
	);
	const frame = await frameWith(
		t,
		(value) => value.includes("/repo/evidence/"),
		"the cited screenshots' metadata",
	);
	// The citation keeps its own metadata instead of a picture, and the bytes were
	// never asked for: a terminal that cannot draw an image costs no read.
	expect(frame).toContain("/repo/evidence/01J000000000000000000000A.png");
	expect(frame).toContain("/repo/evidence/01J000000000000000000000B.png");
	expect(reads).toBe(0);
	t.renderer.destroy();
});

test("with kitty graphics the cited screenshots are mounted in place", async () => {
	// The same path the non-kitty case composes: a fallback line would carry it, so
	// this assertion fails if the image branch is never reached.
	let reads = 0;
	const images = () => {
		reads += 1;
		return { [SHOT.id]: PNG, [CITED.id]: PNG };
	};
	const t = await testRender(
		() =>
			subview({
				report: REPORT,
				kitty: true,
				images,
				pathOf: (item) => `/repo/evidence/${item.file}`,
			}),
		{
			width: 140,
			height: 30,
		},
	);
	await t.flush();
	setRendererCapabilities(t.renderer, { kitty_graphics: true });
	const frame = await frameWith(
		t,
		(value) => value.includes("The cart was empty"),
		"the report body",
	);
	// The image takes its own rows instead of the text fallback, so a cited
	// picture is not also described beneath itself. The focused sidebar row paints
	// its own path, so the two cited files are named rather than the prefix.
	expect(frame).not.toContain("/repo/evidence/01J000000000000000000000A.png");
	expect(frame).not.toContain("/repo/evidence/01J000000000000000000000B.png");
	// …and the bytes were asked for, so the fallback was not taken for another
	// reason (a missing `images` prop).
	expect(reads).toBeGreaterThan(0);
	t.renderer.destroy();
});

test("a cited screenshot whose bytes land after the first paint still mounts", async () => {
	// The route starts the cited-image reads once the report text is in, so the
	// item is projected before any bytes exist: the image branch has to be
	// reactive, or the picture stays a caption for the life of the page.
	const [images, setImages] = createSignal<
		Readonly<Record<string, Uint8Array>>
	>({});
	const t = await testRender(
		() =>
			subview({
				report: REPORT,
				kitty: true,
				images,
				pathOf: (item) => `/repo/evidence/${item.file}`,
			}),
		{ width: 140, height: 30 },
	);
	await t.flush();
	setRendererCapabilities(t.renderer, { kitty_graphics: true });
	// Nothing is mounted yet, so the citation paints its metadata fallback.
	const pending = await frameWith(
		t,
		(value) => value.includes("/repo/evidence/"),
		"the cited screenshot's metadata",
	);
	expect(pending).toContain("/repo/evidence/01J000000000000000000000A.png");
	// The bytes land: the fallback goes away in place of the image.
	setImages({ [SHOT.id]: PNG, [CITED.id]: PNG });
	const painted = await frameWith(
		t,
		(value) =>
			value.includes("The cart was empty") &&
			!value.includes("/repo/evidence/01J000000000000000000000A.png"),
		"the mounted image in place of the citation's metadata",
	);
	expect(painted).not.toContain("/repo/evidence/01J000000000000000000000A.png");
	t.renderer.destroy();
});

test("the sidebar keeps the flow grouping and the focused step's detail", async () => {
	const first: StageJournalEntry = {
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
	};
	const journal: StageJournal = {
		workflowId: "wf-flow",
		entries: [first],
		flowPage: "stage-flow.html",
	};
	const [selected, setSelected] = createSignal(0);
	const t = await testRender(
		() => (
			<EvidenceSubview
				entries={[SHOT, LOOSE]}
				journal={journal}
				reportState="none"
				kitty={false}
				selectedIndex={selected()}
			/>
		),
		{ width: 140, height: 30 },
	);
	const segmented = await t.waitForFrame((value) =>
		value.includes("Segment 1"),
	);
	// The step is a row of its own, before the evidence its segment holds.
	expect(segmented).toContain("00:02 open the cart");
	// Selecting the step paints where it ran and what it saw, exactly as the panel
	// did before the listing moved here.
	setSelected(0);
	await t.flush();
	expect(
		await t.waitForFrame((value) => value.includes("cart is empty")),
	).toBeTruthy();
	// Selecting an evidence row replaces the step's detail with that entry's own,
	// so the detail pane really follows the selection rather than the default row.
	setSelected(2);
	await t.flush();
	const evidenceRow = await t.waitForFrame((value) =>
		value.includes("recorded 2026-01-01T12:04:05.000Z"),
	);
	expect(evidenceRow).not.toContain("expected cart is empty");
	// The trailing group holds what no segment referenced.
	setSelected(3);
	await t.flush();
	expect(
		await t.waitForFrame((value) => value.includes("Unreferenced")),
	).toBeTruthy();
	t.renderer.destroy();
});

test("a tap selects a row and a tap on the selected row activates it", async () => {
	const selectedIndexes: number[] = [];
	const activated: number[] = [];
	const [selected, setSelected] = createSignal(0);
	const t = await testRender(
		() => (
			<EvidenceSubview
				entries={ENTRIES}
				report={() => REPORT}
				reportState="ready"
				kitty={false}
				selectedIndex={selected()}
				onSelectIndex={(index) => {
					selectedIndexes.push(index);
					setSelected(index);
				}}
				onActivateRow={(index) => activated.push(index)}
			/>
		),
		{ width: 140, height: 30 },
	);
	await t.waitForFrame((value) => value.includes("run log"));
	// The sidebar's rows are newest first: row 0 is the log, row 2 the oldest
	// screenshot. The pane sits on the right, so the tap column is past the report.
	await t.mockMouse.click(120, 2);
	await t.flush();
	expect(selectedIndexes).toEqual([1]);
	expect(activated).toEqual([]);
	// A second tap on the row that is now selected is the pointer's `Enter`: the
	// page resolves it through the same activation callback the keyboard uses.
	await t.mockMouse.click(120, 2);
	await t.flush();
	expect(activated).toEqual([1]);
	t.renderer.destroy();
});

test("a run with no evidence opens with an empty sidebar, not an error", async () => {
	const t = await testRender(
		() => subview({ entries: [], reportState: "none" }),
		{
			width: 120,
			height: 24,
		},
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("No evidence attached yet"),
	);
	// The pane states the fact once, counts nothing, and the report pane's own
	// message is the neutral one rather than a failure.
	expect(frame).toContain("No report attached");
	expect(frame).not.toContain("entries");
	expect(frame).not.toContain("could not be read");
	t.renderer.destroy();
});

test("the sidebar separates a pending read from a failed one", async () => {
	const loading = await testRender(
		() => subview({ entries: [], state: "loading", reportState: "none" }),
		{ width: 120, height: 24 },
	);
	const loadingFrame = await loading.waitForFrame((value) =>
		value.includes("Loading evidence…"),
	);
	expect(loadingFrame).not.toContain("No evidence attached yet");
	loading.renderer.destroy();

	const failed = await testRender(
		() =>
			subview({
				entries: [],
				state: "error",
				error: "the read failed",
				reportState: "none",
			}),
		{ width: 120, height: 24 },
	);
	const failedFrame = await failed.waitForFrame((value) =>
		value.includes("Evidence could not be read: the read failed"),
	);
	expect(failedFrame).not.toContain("No evidence attached yet");
	failed.renderer.destroy();
});

test("the sidebar paints the row list the route hands it", async () => {
	// The route computes the grouping once per refresh and shares it with the
	// selection clamp and the key handler; a pane that derived its own rows would
	// paint something else here, because this entry list derives nothing.
	const supplied: EvidenceListRow[] = [
		{
			header: "◇ supplied by the route",
			label: evidenceRowLabel(SHOT),
			entry: SHOT,
		},
	];
	const t = await testRender(
		() => subview({ entries: [], reportState: "none", rows: () => supplied }),
		{ width: 120, height: 24 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("supplied by the route"),
	);
	expect(frame).toContain("empty cart");
	expect(frame).not.toContain("No evidence attached yet");
	t.renderer.destroy();
});

test("a failed refresh is named over the rows that are still listed", async () => {
	// A read that failed over a manifest the page still paints is the common case:
	// the rows are stale, not empty, and the page that owns the listing has to say
	// so — with the same marker the grid's summary row carries.
	const t = await testRender(
		() => subview({ report: REPORT, state: "error", error: "the read failed" }),
		{ width: 140, height: 30 },
	);
	const frame = await frameWith(
		t,
		(value) => value.includes("last read failed"),
		"the failed-read marker",
	);
	expect(frame).toContain("empty cart");
	expect(frame).toContain("3 entries");
	// The rows are painted, so the empty-state message is not what is on screen.
	expect(frame).not.toContain("No evidence attached yet");
	t.renderer.destroy();
});
