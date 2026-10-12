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
import { App } from "../../src/tui/dash/App.tsx";
import { testDashboard } from "../../src/tui/dash/demo.ts";
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
	options: { readonly file?: FileAnswer } = {},
): FakeGateway {
	const files: string[] = [];
	const observes: number[] = [];
	const subscriptions: GatewayEventHandlers[] = [];
	const gateway = {
		kind: "in-process",
		connectionState: () => "open",
		observe: async (observation: ObservationRequest) => {
			if (observation.kind === "dashboard") return testDashboard();
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
