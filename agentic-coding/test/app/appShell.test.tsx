/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { createSignal, onCleanup, onMount } from "solid-js";
import { App } from "../../src/tui/otel/app/App";
import { TraceDb } from "../../src/tui/otel/model/db";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";
import { pressEscapeAndSettle, renderUntil } from "./support/terminal";

// The unified shell renders one renderer with page-based chrome
// (replace-nested-tabs-with-page-navigation, tasks 2.1/2.4): Home lists the
// destinations, a category page lists its children, and the feature body mounts
// at the destination the route names. The environment body is injected as a
// render hook so the test does not need the devenv backend.

// Home mode mounts the Wiki body, which reads a wiki root; give it a readable
// concept so it never opens the global error modal (that overlay owns input
// until it is dismissed and would swallow the keys these tests send).
const previousWikiRoot = process.env.HERDR_WIKI_DIR;
let wikiRoot: string;

beforeEach(() => {
	wikiRoot = mkdtempSync(join(tmpdir(), "unified-shell-wiki-"));
	process.env.HERDR_WIKI_DIR = wikiRoot;
	writeFileSync(
		join(wikiRoot, "demo.md"),
		"---\ntype: concept\ntitle: Demo\ndescription: demo concept\nstatus: stable\n---\n\n# Demo\n\nBody text.\n",
	);
});

afterEach(() => {
	if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
	else process.env.HERDR_WIKI_DIR = previousWikiRoot;
	rmSync(wikiRoot, { recursive: true, force: true });
});

const pressEscape = pressEscapeAndSettle;

test("a full-feature attach labels its capabilities and omits Environments", async () => {
	const dir = mkdtempSync(join(tmpdir(), "unified-attach-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => (
			<App
				repos={["/demo"]}
				db={db}
				traceStore={new TraceStore()}
				metricStore={new MetricStore()}
				logStore={new LogStore()}
				topologyStore={new TopologyStore()}
				attached
				attachLabel="attached http://host:4051 · workflow + observability · environment features unavailable"
			/>
		),
		{ width: 140, height: 40 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("workflow + observability"),
	);
	expect(frame).toContain("environment features unavailable");
	expect(frame).not.toContain("Environments");
	t.renderer.destroy();
	db.close();
});

async function renderUnifiedShell() {
	const dir = mkdtempSync(join(tmpdir(), "unified-shell-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => (
			<App
				repos={["/demo"]}
				db={db}
				traceStore={new TraceStore()}
				metricStore={new MetricStore()}
				logStore={new LogStore()}
				topologyStore={new TopologyStore()}
				environments={{ serverUrl: "http://127.0.0.1:4050" }}
				renderEnvironments={() => <text>ENVIRONMENTS-BODY</text>}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.renderOnce();
	return { t, db };
}

/** Home mode: the entry is the Home page, so Wiki and the workflow page exist. */
async function renderHomeShell() {
	const dir = mkdtempSync(join(tmpdir(), "unified-home-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			const keymap = createDefaultOpenTuiKeymap(renderer);
			const dispose = keymap.registerLayerFields({
				appView(value, ctx) {
					ctx.require("app.view", String(value));
				},
				activeModal(value, ctx) {
					ctx.require("modal.active", String(value));
				},
				textEntry(value, ctx) {
					ctx.require("textEntry.active", Boolean(value));
				},
			});
			keymap.setData("app.view", "home");
			keymap.setData("modal.active", "none");
			onCleanup(dispose);
			return (
				<App
					repos={["/demo"]}
					db={db}
					traceStore={new TraceStore()}
					metricStore={new MetricStore()}
					logStore={new LogStore()}
					topologyStore={new TopologyStore()}
					environments={{ serverUrl: "http://127.0.0.1:4050" }}
					renderEnvironments={() => <text>ENVIRONMENTS-BODY</text>}
					dashboard={{ mode: "home", keymap }}
				/>
			);
		},
		{ width: 140, height: 40 },
	);
	await t.renderOnce();
	return { t, db };
}

test("the default full-application entry opens Home with its destinations", async () => {
	const { t, db } = await renderHomeShell();
	const frame = await t.waitForFrame((value) => value.includes("Home"));
	expect(frame).toContain("Environments");
	expect(frame).toContain("Observability");
	expect(frame).toContain("Wiki");
	expect(frame).toContain("Settings");
	// Workflow creation is contextual: Home offers no Workflows destination.
	expect(frame).not.toContain("Workflows");
	expect(frame).not.toContain("ENVIRONMENTS-BODY");
	t.renderer.destroy();
	db.close();
});

test("a destination opens its category page and then the feature body", async () => {
	const { t, db } = await renderUnifiedShell();
	// The shell without a dashboard starts on Environments.
	const page = await t.waitForFrame((value) => value.includes("Applications"));
	expect(page).toContain("Libraries");
	expect(page).toContain("Kubernetes");
	expect(page).toContain("Home › Environments");
	expect(page).not.toContain("ENVIRONMENTS-BODY");

	// Enter opens the first category destination and mounts the body.
	t.mockInput.pressEnter();
	const frame = await t.waitForFrame((value) =>
		value.includes("ENVIRONMENTS-BODY"),
	);
	expect(frame).toContain("Home › Environments › Applications");
	t.renderer.destroy();
	db.close();
});

test("a category page lists the enabled observability destinations", async () => {
	const { t, db } = await renderHomeShell();
	await t.waitForFrame((value) => value.includes("Home"));
	// Home lists Observability second (Environments is first).
	t.mockInput.pressKey("j");
	await t.renderOnce();
	t.mockInput.pressEnter();
	const page = await t.waitForFrame((value) => value.includes("Topology"));
	expect(page).toContain("Traces");
	expect(page).toContain("Metrics");
	expect(page).toContain("Logs");
	expect(page).toContain("Home › Observability");
	// No shell or nested navigation tab row is part of the page.
	expect(page).not.toMatch(/\d-\d/);
	t.renderer.destroy();
	db.close();
});

test("switching destinations keeps the live Environments body mounted", async () => {
	let mounts = 0;
	const dir = mkdtempSync(join(tmpdir(), "unified-shell-state-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => (
			<App
				repos={["/demo"]}
				db={db}
				traceStore={new TraceStore()}
				metricStore={new MetricStore()}
				logStore={new LogStore()}
				topologyStore={new TopologyStore()}
				environments={{ serverUrl: "http://127.0.0.1:4050" }}
				renderEnvironments={() => (
					<StatefulEnvironment onMount={() => mounts++} />
				)}
			/>
		),
		{ width: 120, height: 40 },
	);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, "draft: retained")).toBe(true);
	expect(mounts).toBe(1);
	await pressEscape(t, (frame) => frame.includes("Libraries"));
	const frame = t.captureCharFrame();
	expect(frame).toContain("Home › Environments");
	expect(frame).toContain("Libraries");
	expect(frame).not.toContain("draft: retained");
	expect(mounts).toBe(1);
	t.renderer.destroy();
	db.close();
});

function StatefulEnvironment(props: { onMount: () => void }) {
	const [draft] = createSignal("draft: retained");
	onMount(props.onMount);
	return <text>{draft()}</text>;
}

test("the feature shell renders at a narrow terminal size", async () => {
	const dir = mkdtempSync(join(tmpdir(), "unified-shell-narrow-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => (
			<App
				repos={["/demo"]}
				db={db}
				traceStore={new TraceStore()}
				metricStore={new MetricStore()}
				logStore={new LogStore()}
				topologyStore={new TopologyStore()}
				environments={{ serverUrl: "http://127.0.0.1:4050" }}
				renderEnvironments={() => <text>ENVIRONMENTS-BODY</text>}
			/>
		),
		{ width: 60, height: 20 },
	);
	const frame = await t.waitForFrame((value) => value.includes("Applications"));
	// The breadcrumb stays one line and never overflows the narrow terminal.
	const crumb = frame.split("\n").find((line) => line.includes("›"));
	expect(crumb).toBeDefined();
	expect(crumb?.trimEnd().length).toBeLessThanOrEqual(60);
	t.renderer.destroy();
	db.close();
});

test("a hidden feature body does not consume the visible page's keys", async () => {
	const dir = mkdtempSync(join(tmpdir(), "unified-shell-keymap-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => (
			<App
				repos={["/demo"]}
				db={db}
				traceStore={new TraceStore()}
				metricStore={new MetricStore()}
				logStore={new LogStore()}
				topologyStore={new TopologyStore()}
				environments={{ serverUrl: "http://127.0.0.1:4050" }}
				renderEnvironments={(_onCatalog) => <text>ENV-BODY</text>}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.waitForFrame((value) => value.includes("Applications"));
	// The destination cursor moves with j, and the environment body stays hidden.
	t.mockInput.pressKey("j");
	await t.renderOnce();
	const frame = t.captureCharFrame();
	expect(frame).not.toContain("ENV-BODY");
	expect(frame).toContain("Libraries");
	t.renderer.destroy();
	db.close();
});

test("an open modal owns input across page-navigation keys", async () => {
	const { t, db } = await renderUnifiedShell();
	await t.waitForFrame((value) => value.includes("Applications"));
	t.mockInput.pressKey("?");
	await t.waitForFrame((value) => value.includes("Keybindings"));
	t.mockInput.pressKey("j");
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Keybindings");
	await pressEscape(t);
	const closed = await t.waitForFrame((value) =>
		value.includes("Applications"),
	);
	expect(closed).not.toContain("Keybindings");
	t.renderer.destroy();
	db.close();
});
