/** @jsxImportSource @opentui/solid */
// The Evidence panel inside the dashboard route (`add-dashboard-evidence-panel`,
// tasks 1.1/2.2): the manifest the route read reaches the panel, the preview
// bytes are read only under kitty graphics, and a read that did not succeed is
// never rendered as "no evidence attached".
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
import type { DashboardData } from "../../src/contracts/workflow.ts";
import { App } from "../../src/tui/dash/App.tsx";
import { testDashboard } from "../../src/tui/dash/demo.ts";
import { EVIDENCE_PANEL_LINES } from "../../src/tui/dash/evidence-panel.ts";
import {
	activeNotification,
	resetNotifications,
} from "../../src/tui/dash/notifications.ts";
import { loadEvidenceFile } from "../../src/tui/data/evidence.ts";
import { clearGateway, configureGateway } from "../../src/tui/data/index.ts";

type Test = Awaited<ReturnType<typeof testRender>>;

const PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	),
	(character) => character.charCodeAt(0),
);

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

/** Newest first in the panel: `LATER` paints above `EARLIER`. */
const EARLIER = entry("01J000000000000000000000A", "first shot");
const LATER = entry("01J000000000000000000000B", "second shot");
const MANIFEST: EvidenceManifest = {
	workflowId: "demo",
	entries: [EARLIER, LATER],
	bytes: 2468,
	quotaBytes: 1024,
};

interface FakeGateway {
	readonly gateway: DashboardGateway;
	/** The ids the preview read asked for. */
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

/** What the entry-bytes read answers. */
type FileAnswer = "png" | "absent" | "error";

function fakeGateway(
	evidence: EvidenceSource,
	options: {
		readonly file?: FileAnswer;
		/** The dashboard the panels render, when a test needs its own rows. */
		readonly dashboard?: DashboardData;
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
			if (options.file === "error") throw new Error("the preview read failed");
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

test("the workflow's evidence reaches the panel and its bytes are read only under kitty graphics", async () => {
	const fake = fakeGateway(MANIFEST);
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);

	// The manifest the route read is what the panel paints.
	const listed = await t.waitForFrame((frame) => frame.includes("first shot"));
	expect(listed).toContain("second shot");

	// Focus the Evidence row (Change → Shift+K) and let the route settle.
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await waitFor(t, () => false, 4);
	// Without kitty graphics the panel never asks for the bytes at all, not even
	// when the selection moves.
	t.mockInput.pressKey("j");
	await t.renderOnce();
	await waitFor(t, () => false, 4);
	expect(fake.files).toEqual([]);

	// The renderer's probe then reports kitty graphics, and moving the selection
	// re-runs the preview read for the newly selected entry.
	setRendererCapabilities(t.renderer, { kitty_graphics: true });
	t.mockInput.pressKey("k");
	await t.renderOnce();
	await waitFor(t, () => fake.files.length > 0);
	// Row 0 is the newest entry, row 1 the older one: the read names the row the
	// selection moved to.
	expect(fake.files).toEqual([LATER.id]);

	t.mockInput.pressKey("j");
	await t.renderOnce();
	await waitFor(t, () => fake.files.length > 1);
	expect(fake.files).toEqual([LATER.id, EARLIER.id]);

	// Back to the first row: the entry the selection left had its bytes dropped,
	// so this is a read and not a cache hit — one preview is resident at a time.
	t.mockInput.pressKey("k");
	await t.renderOnce();
	await waitFor(t, () => fake.files.length > 2);
	expect(fake.files).toEqual([LATER.id, EARLIER.id, LATER.id]);

	// A workflow event refreshes the dashboard, and the refresh must not re-read
	// the immutable bytes of a selection that did not move.
	const subscription = fake.subscriptions[0];
	if (!subscription) throw new Error("the route did not subscribe");
	subscription.onEvent({
		instance: "test",
		sequence: 1,
		domain: "workflow",
		kind: "workflow.updated",
		resource: "/demo",
		at: "2026-01-01T12:04:05.000Z",
		payload: {},
	});
	await new Promise((resolve) => setTimeout(resolve, 300));
	await t.renderOnce();
	expect(fake.files).toEqual([LATER.id, EARLIER.id, LATER.id]);

	// The dashboard body was disposed: its last preview's bytes are dropped with
	// it, so reading the same entry goes back to the gateway instead of being
	// answered from the process-wide cache.
	t.renderer.destroy();
	await loadEvidenceFile("/demo", "demo", LATER.id);
	expect(fake.files).toEqual([LATER.id, EARLIER.id, LATER.id, LATER.id]);
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

test("a preview the gateway answers as gone says so, and the next refresh retries it", async () => {
	const fake = fakeGateway(MANIFEST, { file: "absent" });
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	setRendererCapabilities(t.renderer, { kitty_graphics: true });
	t.mockInput.pressKey("j");
	await t.renderOnce();
	await waitFor(t, () => fake.files.length > 0, 160);
	expect(fake.files).toEqual([EARLIER.id]);

	const frame = await t.waitForFrame((value) =>
		value.includes("Preview unavailable"),
	);
	expect(frame).not.toContain("Loading preview…");

	// The absent answer is droppable and dropped: the next refresh reaches the
	// gateway again instead of being served the cached `undefined`.
	await publishEvent(t, fake);
	await waitFor(t, () => fake.files.length > 1, 160);
	expect(fake.files).toEqual([EARLIER.id, EARLIER.id]);
	t.renderer.destroy();
}, 20000);

test("a preview read that fails says so, and the next refresh retries it", async () => {
	const fake = fakeGateway(MANIFEST, { file: "error" });
	configureGateway(fake.gateway);
	const t = await testRender(() => <TestDashboard />, {
		width: 140,
		height: 40,
	});
	await dashboardReady(t);
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	setRendererCapabilities(t.renderer, { kitty_graphics: true });
	t.mockInput.pressKey("j");
	await t.renderOnce();
	await waitFor(t, () => fake.files.length > 0, 160);
	expect(fake.files).toEqual([EARLIER.id]);

	const frame = await t.waitForFrame((value) =>
		value.includes("Preview could not be read"),
	);
	expect(frame).not.toContain("Loading preview…");
	await publishEvent(t, fake);
	await waitFor(t, () => fake.files.length > 1, 160);
	expect(fake.files).toEqual([EARLIER.id, EARLIER.id]);
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
	await t.waitForFrame((frame) => frame.includes("first shot"));

	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
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

/** The three terminal sizes the detail grid has to survive, with the evidence
 * row each one earns: the compact height, and the 30% cap on the short one. */
const LAYOUT_SIZES = [
	{ name: "small", width: 100, height: 24, evidenceLines: 7 },
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
		await t.waitForFrame((frame) => frame.includes("first shot"));
		const rows = frameRows(t, size.height);
		const evidenceTop = rows.findIndex((row) => row.includes("Evidence"));
		// Compact and capped: the row is a fixed height, not the 28% of the
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
	await t.waitForFrame((frame) => frame.includes("first shot"));
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
	// Collapsed: the title row carries the empty state, so the seven rows the
	// panel would otherwise take stay with the grid above it.
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
