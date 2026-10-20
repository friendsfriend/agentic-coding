/** @jsxImportSource @opentui/solid */
// The Evidence panel and its subview inside the dashboard route
// (`evidence-summary-subview`, tasks 1.1/2.2/4.2).
//
// The grid's panel is one line of kind counts; `Enter` opens the evidence page,
// which reads the run's report and the bytes of the screenshots it cites, lists
// the whole manifest beside it, and answers `Esc`. Nothing about the manifest is
// read from disk for the panel itself, a read that did not succeed is never
// rendered as "no evidence attached", and a journal step row keeps its selection
// across a refresh.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { setRendererCapabilities } from "@opentui/core/testing";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import type {
	EvidenceEntry,
	EvidenceManifest,
	ObservationRequest,
} from "../../src/contracts/environment.ts";
import type {
	DashboardGateway,
	GatewayEventHandlers,
} from "../../src/contracts/gateway.ts";
import type {
	StageJournal,
	StageJournalEntry,
} from "../../src/contracts/stages.ts";
import type { DashboardData } from "../../src/contracts/workflow.ts";
import { App } from "../../src/tui/dash/App.tsx";
import { testDashboard } from "../../src/tui/dash/demo.ts";
import {
	EVIDENCE_EMPTY_LINES,
	EVIDENCE_PANEL_LINES,
	evidenceKindSummary,
} from "../../src/tui/dash/evidence-panel.ts";
import {
	activeNotification,
	resetNotifications,
} from "../../src/tui/dash/notifications.ts";
import {
	evidenceFileKey,
	loadEvidenceFile,
} from "../../src/tui/data/evidence.ts";
import {
	clearGateway,
	configureGateway,
	invalidateKey,
} from "../../src/tui/data/index.ts";

type Test = Awaited<ReturnType<typeof testRender>>;

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

/** Newest first in the sidebar: `LATER` paints above `EARLIER`. */
const EARLIER = entry({
	id: "01J000000000000000000000A",
	caption: "first shot",
});
const LATER = entry({
	id: "01J000000000000000000000B",
	caption: "second shot",
	bytes: 2048,
});
/** The run's report: the newest flagged entry, and a markdown file rather than a
 * picture. */
const REPORT = entry({
	id: "01J000000000000000000000C",
	kind: "other",
	file: "01J000000000000000000000C.md",
	caption: "run report",
	report: true,
	bytes: 300,
});
const MANIFEST: EvidenceManifest = {
	workflowId: "demo",
	entries: [EARLIER, LATER, REPORT],
	bytes: 3582,
	quotaBytes: 1024,
};
/** A report that cites one of the two screenshots and nothing else: only the
 * cited one is ever read as image bytes. */
const REPORT_TEXT = `# Run report\n\nThe cart was empty [^${EARLIER.id}].\n`;

interface FakeGateway {
	readonly gateway: DashboardGateway;
	/** The ids whose bytes the route asked for, in read order. */
	readonly files: string[];
	/** How many times the manifest was read. */
	readonly observes: number[];
	/** The subscription the route registered, so a test can publish an event. */
	readonly subscriptions: GatewayEventHandlers[];
}

/** The manifest read's answer: a value, or a failure that a test can change
 * between reads. */
type EvidenceSource =
	| EvidenceManifest
	| Error
	| (() => EvidenceManifest | Error);

/** What the entry-bytes read answers: a picture, a markdown report, or the
 * gateway's two failure modes. */
type FileAnswer = "png" | "absent" | "error";

function fakeGateway(
	evidence: EvidenceSource,
	options: {
		readonly file?: FileAnswer;
		/** What the report entry's own read answers. */
		readonly report?: FileAnswer | "text";
		/** The dashboard the panels render, when a test needs its own rows. */
		readonly dashboard?: DashboardData;
		/** The stage step journal the route reads, when a test paints flow rows. */
		readonly journal?: StageJournal;
		/** A hold on the report read: the test decides when it completes, so a state
		 * change can land while it is in flight. */
		readonly reportGate?: () => Promise<void>;
		/** The same hold for a cited screenshot's bytes. */
		readonly fileGate?: () => Promise<void>;
	} = {},
): FakeGateway {
	const files: string[] = [];
	const observes: number[] = [];
	const subscriptions: GatewayEventHandlers[] = [];
	const gateway = {
		kind: "in-process",
		connectionState: () => "open",
		observe: async (observation: ObservationRequest) => {
			if (observation.kind === "dashboard")
				return options.dashboard ?? testDashboard();
			if (observation.kind === "stage-journal" && options.journal !== undefined)
				return options.journal;
			if (observation.kind === "evidence") {
				observes.push(observes.length + 1);
				const answer = typeof evidence === "function" ? evidence() : evidence;
				if (answer instanceof Error) throw answer;
				// Fresh objects per read, like the real observation decode: a refresh that
				// changed nothing still re-runs the route's effects.
				return {
					...answer,
					entries: answer.entries.map((item) => ({ ...item })),
				};
			}
			return [];
		},
		// The route's fast first paint: no seed in this harness.
		view: async () => {
			throw new Error("no seed view");
		},
		evidenceFile: async (_workflowId: string, id: string) => {
			files.push(id);
			if (id === REPORT.id) {
				if (options.reportGate) await options.reportGate();
				const answer = options.report ?? "text";
				if (answer === "error") throw new Error("the report read failed");
				if (answer === "absent") return undefined;
				return new TextEncoder().encode(REPORT_TEXT);
			}
			if (options.fileGate) await options.fileGate();
			if (options.file === "error") throw new Error("the image read failed");
			if (options.file === "absent") return undefined;
			return PNG;
		},
		subscribe: (handlers: GatewayEventHandlers) => {
			subscriptions.push(handlers);
			return () => {};
		},
	} as unknown as DashboardGateway;
	return { gateway, files, observes, subscriptions };
}

/**
 * Publish one `workflow.updated` event and wait for the manifest read it causes.
 * The route debounces bursts and throttles refreshes to one per second, so the
 * read is awaited rather than slept for.
 */
async function publishEvent(t: Test, fake: FakeGateway) {
	const subscription = fake.subscriptions[0];
	if (!subscription) throw new Error("the route did not subscribe");
	const before = fake.observes.length;
	subscription.onEvent({
		instance: "test",
		sequence: 1,
		domain: "workflow",
		kind: "workflow.updated",
		resource: "/demo",
		at: "2026-01-01T12:04:05.000Z",
		payload: {},
	});
	await waitFor(t, () => fake.observes.length > before, 160);
	expect(fake.observes.length).toBeGreaterThan(before);
}

afterEach(() => clearGateway());
// The notification signal is module-global: bun runs all files in one process,
// so a toast left by an earlier file would bleed into this one.
beforeEach(() => resetNotifications());

function TestDashboard() {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	const disposeKeymap = keymap.appendEventMatchResolver((event, ctx) => {
		if (
			!event.shift ||
			event.ctrl ||
			event.meta ||
			event.super ||
			event.name.length !== 1
		)
			return undefined;
		const upper = event.name.toUpperCase();
		return upper !== event.name
			? [
					ctx.resolveKey({
						name: upper,
						ctrl: false,
						shift: false,
						meta: false,
						super: false,
					}),
				]
			: undefined;
	});
	const dispose = keymap.registerLayerFields({
		name() {},
		appView(value, ctx) {
			ctx.require("app.view", String(value));
		},
		activeModal(value, ctx) {
			ctx.require("modal.active", String(value));
		},
		agentView(value, ctx) {
			ctx.require("agent.view", String(value));
		},
		// The evidence page is a dashboard body page, so it takes the keyboard
		// through its own field exactly like the agent session does.
		evidenceView(value, ctx) {
			ctx.require("evidence.view", String(value));
		},
	});
	onCleanup(() => {
		disposeKeymap();
		dispose();
	});
	return <App repo="/demo" workflowId="demo" keymap={keymap} />;
}

/** Dismiss the auto-opened plan review popup the demo data asks for. */
async function dashboardReady(t: Test) {
	await t.waitForFrame((frame) => frame.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));
}

async function waitFor(t: Test, predicate: () => boolean, ticks = 40) {
	for (let index = 0; index < ticks; index++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
		await t.renderOnce();
	}
}

/** Focus the Evidence panel in the grid (Change → Shift+K). */
async function focusEvidence(t: Test) {
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
}

test("the panel is a summary, and Enter opens the report beside the manifest", async () => {
	const fake = fakeGateway(MANIFEST);
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);

	// The manifest the route read is what the panel counts — and nothing of it is
	// listed: the row is the summary.
	const summary = evidenceKindSummary(MANIFEST.entries);
	const listed = await t.waitForFrame((frame) => frame.includes(summary));
	expect(summary).toBe("2 screenshots · 1 other");
	expect(listed).not.toContain("first shot");
	expect(listed).not.toContain("second shot");
	// The panel spends no file read: a refresh of the grid must not pull bytes.
	expect(fake.files).toEqual([]);

	await focusEvidence(t);
	expect(fake.files).toEqual([]);

	// Enter opens the page and its report read, which is the only read an open
	// costs on a terminal that cannot draw images.
	t.mockInput.pressEnter();
	await waitFor(t, () => fake.files.length > 0, 160);
	expect(fake.files).toEqual([REPORT.id]);
	const report = await t.waitForFrame((frame) =>
		frame.includes("The cart was empty"),
	);
	// The sidebar lists every entry, report included, in the page's own order.
	expect(report).toContain("second shot");
	expect(report).toContain("first shot");
	// No image is mounted without kitty graphics, so the cited screenshot stays a
	// line of metadata rather than half blocks.
	expect(report).not.toMatch(/[\u2580-\u259f]/);

	// Esc returns to the grid, whose row is the summary again.
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => frame.includes(summary));
	t.renderer.destroy();
}, 20000);

test("with kitty graphics the report reads the screenshots it cites, and only those", async () => {
	const fake = fakeGateway(MANIFEST);
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);
	await focusEvidence(t);
	t.mockInput.pressEnter();
	await waitFor(t, () => fake.files.includes(REPORT.id), 160);

	// The report cites one of the two screenshots: the capability probe answers,
	// and the next dashboard refresh is what re-runs the read for the cited set.
	setRendererCapabilities(t.renderer, { kitty_graphics: true });
	await publishEvent(t, fake);
	await waitFor(t, () => fake.files.includes(EARLIER.id), 160);
	expect(fake.files.filter((id) => id !== REPORT.id)).toEqual([EARLIER.id]);

	// A refresh with the same citation is a cache hit, not a second read: the
	// report's bytes are immutable once written.
	await publishEvent(t, fake);
	await waitFor(t, () => false, 4);
	expect(fake.files.filter((id) => id !== REPORT.id)).toEqual([EARLIER.id]);

	// The dashboard body was disposed with the page: its cited bytes are dropped
	// with it, so reading the same entry goes back to the gateway instead of being
	// answered from the process-wide cache.
	t.renderer.destroy();
	await loadEvidenceFile("/demo", "demo", EARLIER.id);
	expect(fake.files.filter((id) => id !== REPORT.id)).toEqual([
		EARLIER.id,
		EARLIER.id,
	]);
}, 20000);

test("a cited screenshot the cache dropped is read again, not painted as missing", async () => {
	// The same race the report text recovers from: an event gap or a reconnect
	// clears the cache while the bytes are in flight, so the answer is dropped
	// before it was ever an answer. A picture that exists must not spend the rest
	// of the open pretending it is absent.
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	let gated = false;
	const fake = fakeGateway(MANIFEST, {
		fileGate: () => {
			if (gated) return Promise.resolve();
			gated = true;
			return held;
		},
	});
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);
	await focusEvidence(t);
	t.mockInput.pressEnter();
	await waitFor(t, () => fake.files.includes(REPORT.id), 160);
	// The capability probe answers and the dashboard refreshes, which is when the
	// cited set is read — the same handshake the kitty test waits for.
	setRendererCapabilities(t.renderer, { kitty_graphics: true });
	await publishEvent(t, fake);
	await waitFor(t, () => fake.files.includes(EARLIER.id), 200);
	expect(fake.files.filter((id) => id === EARLIER.id)).toHaveLength(1);

	// The key moves on mid-read, and the dropped answer is not "the file is gone".
	invalidateKey(evidenceFileKey("/demo", "demo", EARLIER.id));
	release();
	await waitFor(
		t,
		() => fake.files.filter((id) => id === EARLIER.id).length >= 2,
		200,
	);
	// One retry, then the bytes are in hand: the citation stops being a caption.
	expect(fake.files.filter((id) => id === EARLIER.id)).toHaveLength(2);
	const frame = await t.waitForFrame((value) =>
		value.includes("The cart was empty"),
	);
	expect(frame).not.toContain("The report file is not on this machine.");
	t.renderer.destroy();
}, 20000);

test("a report the gateway answers as gone says so, and re-opening retries it", async () => {
	const fake = fakeGateway(MANIFEST, { report: "absent" });
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);
	await focusEvidence(t);
	t.mockInput.pressEnter();
	const gone = await t.waitForFrame((frame) =>
		frame.includes("The report file is not on this machine."),
	);
	expect(gone).not.toContain("Loading report…");
	// The sidebar is unaffected: a report that is gone is not a manifest that is.
	expect(gone).toContain("first shot");
	expect(fake.files).toEqual([REPORT.id]);

	// The absent answer is dropped, so re-opening reaches the gateway again rather
	// than being served the cached `undefined`.
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => frame.includes("2 screenshots"));
	t.mockInput.pressEnter();
	await waitFor(t, () => fake.files.length > 1, 160);
	expect(fake.files).toEqual([REPORT.id, REPORT.id]);
	t.renderer.destroy();
}, 20000);

test("a report read the cache dropped stays pending instead of reading as missing", async () => {
	// The manifest refreshes about once a second while a run streams, and a
	// dropped cache entry is not a file the gateway called gone: a read that
	// finishes after its key moved on is an answer nobody asked for any more, so
	// the pane stays pending and the next refresh reads again.
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	let gated = false;
	const fake = fakeGateway(MANIFEST, {
		reportGate: () => {
			if (gated) return Promise.resolve();
			gated = true;
			return held;
		},
	});
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);
	await focusEvidence(t);
	t.mockInput.pressEnter();
	await waitFor(t, () => fake.files.includes(REPORT.id), 160);

	// The key moves on while the read is in flight — the page closing is what
	// normally does this — and the in-flight answer is then dropped by the cache.
	invalidateKey(evidenceFileKey("/demo", "demo", REPORT.id));
	release();
	await waitFor(t, () => false, 6);
	const pending = await t.waitForFrame((frame) =>
		frame.includes("Loading report…"),
	);
	expect(pending).not.toContain("The report file is not on this machine.");
	expect(pending).not.toContain("The report could not be read");

	// A refresh re-runs the read, which now answers: the report paints.
	await publishEvent(t, fake);
	const painted = await t.waitForFrame((frame) =>
		frame.includes("The cart was empty"),
	);
	expect(painted).toContain("The cart was empty");
	expect(fake.files).toEqual([REPORT.id, REPORT.id]);
	t.renderer.destroy();
}, 20000);

test("closing the page drops the report bytes it read", async () => {
	// The bytes are only kept while the pane shows them: a closed page leaves
	// nothing resident, so opening it again reads the immutable file again rather
	// than growing the process-wide cache by one report per workflow.
	const fake = fakeGateway(MANIFEST);
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);
	await focusEvidence(t);
	t.mockInput.pressEnter();
	await t.waitForFrame((frame) => frame.includes("The cart was empty"));
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => frame.includes("2 screenshots"));
	expect(fake.files).toEqual([REPORT.id]);

	// Reading the same report now reaches the gateway instead of the cache.
	await loadEvidenceFile("/demo", "demo", REPORT.id);
	expect(fake.files).toEqual([REPORT.id, REPORT.id]);
	t.renderer.destroy();
}, 20000);

test("a report read that fails is reported, and the next open retries it", async () => {
	const fake = fakeGateway(MANIFEST, { report: "error" });
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);
	await focusEvidence(t);
	t.mockInput.pressEnter();
	const failed = await t.waitForFrame((frame) =>
		frame.includes("The report could not be read"),
	);
	expect(failed).toContain("the report read failed");
	expect(failed).not.toContain("No report attached");

	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => frame.includes("2 screenshots"));
	t.mockInput.pressEnter();
	await waitFor(t, () => fake.files.length > 1, 160);
	expect(fake.files).toEqual([REPORT.id, REPORT.id]);
	t.renderer.destroy();
}, 20000);

test("a run that attached no report says so and still lists every entry", async () => {
	// No flagged entry at all: the report panel answers with a fact, and the
	// sidebar is the whole manifest.
	const fake = fakeGateway({ ...MANIFEST, entries: [EARLIER, LATER] });
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);
	await focusEvidence(t);
	t.mockInput.pressEnter();
	const frame = await t.waitForFrame((value) =>
		value.includes("No report attached"),
	);
	expect(frame).toContain("first shot");
	expect(frame).toContain("second shot");
	// Nothing to read: an absent report costs no file read.
	expect(fake.files).toEqual([]);
	t.renderer.destroy();
}, 20000);

test("a refresh keeps the subview's selection on a stage flow step row", async () => {
	// Two steps in two segments, and one manifest entry. The rows the sidebar
	// paints are the two steps and that one entry: a clamp that counted the
	// manifest's entries would bound the selection at 0, so a developer parked on
	// the second step would be thrown back to the first on every refresh.
	const step = (
		seq: number,
		segment: number,
		label: string,
		expected: string,
	): StageJournalEntry => ({
		seq,
		at: "2026-01-01T12:04:05.000Z",
		session: "default",
		label,
		segment,
		offsetMs: seq * 1_000,
		expected,
	});
	const journal: StageJournal = {
		workflowId: "demo",
		entries: [
			step(1, 1, "open the cart", "empty cart"),
			step(2, 2, "checkout", "total 0.00"),
		],
		flowPage: "stage-flow.html",
	};
	const fake = fakeGateway({ ...MANIFEST, entries: [LATER] }, { journal });
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);
	// The panel only says that a flow exists; the steps are the page's.
	const panel = await t.waitForFrame((frame) => frame.includes("flow"));
	expect(panel).not.toContain("open the cart");
	await focusEvidence(t);
	t.mockInput.pressEnter();
	await t.waitForFrame((frame) => frame.includes("open the cart"));

	// Move one row down, onto the second step: its detail only paints while that
	// row is the selected one.
	t.mockInput.pressKey("j");
	await t.renderOnce();
	expect(
		await t.waitForFrame((frame) => frame.includes("total 0.00")),
	).toBeTruthy();

	// A workflow event refreshes the dashboard — the route throttles refreshes to
	// one per second, so the refreshed page is awaited rather than inspected on the
	// next frame — and the selection stays where the developer left it.
	await publishEvent(t, fake);
	await waitFor(t, () => false, 60);
	const after = await t.waitForFrame(() => true);
	expect(after).toContain("total 0.00");
	t.renderer.destroy();
}, 20000);

test("a failed manifest read is reported once per distinct failure, and not as an empty listing", async () => {
	const failure = { message: "the evidence manifest cannot be read" };
	const fake = fakeGateway(() => new Error(failure.message));
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);

	const frame = await t.waitForFrame((value) =>
		value.includes("Evidence could not be read"),
	);
	expect(frame).toContain("the evidence manifest cannot be read");
	expect(frame).not.toContain("No evidence attached yet");
	// The failure is announced where the dashboard reports its other read
	// failures…
	expect(activeNotification()).toEqual({
		message: "Evidence could not be read: the evidence manifest cannot be read",
		type: "error",
	});

	// …a repeat of that same failure is silent: with the toast cleared first, a
	// second announcement would be visible.
	resetNotifications();
	await publishEvent(t, fake);
	expect(activeNotification()).toBeUndefined();

	// …and a different failure announces itself, which is what makes the guard a
	// message comparison rather than a one-shot flag.
	failure.message = "the transport dropped";
	await publishEvent(t, fake);
	expect(activeNotification()).toEqual({
		message: "Evidence could not be read: the transport dropped",
		type: "error",
	});
	t.renderer.destroy();
}, 20000);

test("opening evidence that is not on this machine is reported, not silent", async () => {
	// The fixture's worktree has no evidence directory, so the composed path is
	// missing and the opener is refused before it runs.
	const fake = fakeGateway({ ...MANIFEST, entries: [EARLIER] });
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);
	await t.waitForFrame((frame) => frame.includes("1 screenshot"));

	await focusEvidence(t);
	// Enter opens the page, and Enter on the selected row opens its file.
	t.mockInput.pressEnter();
	await t.waitForFrame((frame) => frame.includes("No report attached"));
	t.mockInput.pressEnter();
	await waitFor(t, () =>
		(activeNotification()?.message ?? "").includes("Could not open evidence"),
	);
	expect(activeNotification()?.type).toBe("error");
	expect(activeNotification()?.message).toContain("is not on this machine");
	t.renderer.destroy();
});

/** A dashboard whose agents are identifiable in a frame and much longer than any
 * of the panel sizes below: 24 two-line rows, so the list always overflows. */
function manyAgents(): DashboardData {
	return {
		...testDashboard(),
		agents: Array.from({ length: 24 }, (_, index) => ({
			role: `agent-${String(index).padStart(2, "0")}`,
			status: "completed" as const,
		})),
	};
}

/** The last agent of the fixture: a role no other panel paints, so a frame match
 * is the agents list and not a mention somewhere else. */
const LAST_AGENT = "agent-23";

/** The summary the grid's evidence row paints for the fixture manifest. */
const SUMMARY = evidenceKindSummary(MANIFEST.entries);

/** The three terminal sizes the detail grid has to survive. The evidence row is
 * a fixed two lines at every one of them: the summary does not grow with the
 * manifest, so the grid above keeps its rows. */
const LAYOUT_SIZES = [
	{
		name: "small",
		width: 100,
		height: 24,
		evidenceLines: EVIDENCE_PANEL_LINES,
	},
	{
		name: "medium",
		width: 120,
		height: 40,
		evidenceLines: EVIDENCE_PANEL_LINES,
	},
	{
		name: "large",
		width: 160,
		height: 60,
		evidenceLines: EVIDENCE_PANEL_LINES,
	},
] as const;

/** Scroll the agents panel to its last row, where a list windowed by the
 * terminal's height instead of the panel's lets the cursor scroll under the
 * evidence row. */
async function scrollAgentsToEnd(t: Test, presses: number) {
	t.mockInput.pressKey("l", { shift: true });
	for (let index = 0; index < presses; index++) t.mockInput.pressKey("j");
	await t.renderOnce();
}

/** The screen's rows from a captured frame: the capture carries a trailing row
 * for the cursor, which is not a row of the dashboard. */
function frameRows(t: Test, height: number): string[] {
	return t.captureCharFrame().split("\n").slice(0, height);
}

test("the compact evidence row leaves the agents panel the rest at every size", async () => {
	const fake = fakeGateway(MANIFEST, { dashboard: manyAgents() });
	configureGateway(fake.gateway);
	for (const size of LAYOUT_SIZES) {
		const t = await testRender(() => <TestDashboard />, {
			width: size.width,
			height: size.height,
		});
		await dashboardReady(t);
		await t.waitForFrame((frame) => frame.includes(SUMMARY));
		const rows = frameRows(t, size.height);
		const evidenceTop = rows.findIndex((row) => row.includes("Evidence"));
		// Compact and capped: the row is a fixed height, not the share of the
		// terminal it used to take, whatever the manifest holds.
		expect(rows.length - evidenceTop, `${size.name} evidence row`).toBe(
			size.evidenceLines,
		);
		// The grid above ends at its own last row plus the one-row gap: the
		// evidence row pushes and resizes nothing.
		expect((rows[evidenceTop - 1] ?? "").trim(), size.name).toBe("");

		await scrollAgentsToEnd(t, 24);
		const scrolled = frameRows(t, size.height);
		const lastAgentRow = scrolled.findIndex((row) => row.includes(LAST_AGENT));
		// The list windows on the rows the panel has: the cursor stays inside the
		// panel instead of being clipped behind the evidence row.
		expect(lastAgentRow, `${size.name} last agent`).toBeGreaterThan(0);
		expect(lastAgentRow, `${size.name} last agent`).toBeLessThan(evidenceTop);
		t.renderer.destroy();
	}
}, 30000);

/** The dashboard as the shell hosts it: the same body, inside a page column that
 * leaves it fewer rows than the terminal has. `dimensions()` still reports the
 * terminal, which is what a list sized by the terminal got wrong. */
function HostedDashboard() {
	return (
		<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
			<box style={{ width: "100%", height: 4 }}>
				<text>shell chrome</text>
			</box>
			<box style={{ width: "100%", flexGrow: 1, minHeight: 0 }}>
				<TestDashboard />
			</box>
		</box>
	);
}

test("the agents panel scrolls inside the body a host leaves it, not the terminal", async () => {
	const fake = fakeGateway(MANIFEST, { dashboard: manyAgents() });
	configureGateway(fake.gateway);
	const t = await testRender(() => <HostedDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);
	await t.waitForFrame((frame) => frame.includes(SUMMARY));
	const evidenceTop = t
		.captureCharFrame()
		.split("\n")
		.findIndex((row) => row.includes("Evidence"));

	await scrollAgentsToEnd(t, 24);
	const lastAgentRow = t
		.captureCharFrame()
		.split("\n")
		.findIndex((row) => row.includes(LAST_AGENT));
	// The body is a few rows shorter than the terminal: a list windowed by the
	// terminal would put the last agent under the evidence row. It measures its own
	// body instead, so the cursor stays inside the panel.
	expect(lastAgentRow).toBeGreaterThan(0);
	expect(lastAgentRow).toBeLessThan(evidenceTop);
	t.renderer.destroy();
}, 20000);

test("a run with no evidence spends one row instead of the grid's height", async () => {
	const fake = fakeGateway(
		{ ...MANIFEST, entries: [] },
		{ dashboard: manyAgents() },
	);
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 100,
		height: 24,
	});
	await dashboardReady(t);
	const frame = await t.waitForFrame((value) =>
		value.includes("No evidence attached yet"),
	);
	const rows = frame.split("\n").slice(0, 24);
	// Collapsed: the title row carries the empty state, so the rows the panel would
	// otherwise take stay with the grid above it.
	expect(EVIDENCE_EMPTY_LINES).toBe(1);
	expect(rows.at(-1)).toContain("Evidence");
	expect(rows.at(-1)).toContain("No evidence attached yet");

	await scrollAgentsToEnd(t, 24);
	const lastAgentRow = frameRows(t, 24).findIndex((row) =>
		row.includes(LAST_AGENT),
	);
	expect(lastAgentRow).toBeGreaterThan(0);
	expect(lastAgentRow).toBeLessThan(rows.length - 1);
	t.renderer.destroy();
}, 20000);
