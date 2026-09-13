/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { createSignal, onMount } from "solid-js";
import { App } from "../../src/tui/otel/app/App";
import { TraceDb } from "../../src/tui/otel/model/db";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";

// The unified shell must expose Environments as a top-level feature and group
// the observability signal views under one Observability feature with sub-tabs
// (compose-unified-feature-shell task 2.1/2.3/2.6). The environment body is
// injected as a render hook so the test does not need the devenv backend.
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

test("the unified shell exposes Environments as a top-level feature", async () => {
	const { t, db } = await renderUnifiedShell();
	const frame = await t.waitForFrame((value) =>
		value.includes("ENVIRONMENTS-BODY"),
	);
	expect(frame).toContain("Environments");
	expect(frame).toContain("Observability");
	t.renderer.destroy();
	db.close();
});

test("selecting Observability shows its traces/metrics/logs/topology sub-tabs", async () => {
	const { t, db } = await renderUnifiedShell();
	await t.waitForFrame((value) => value.includes("ENVIRONMENTS-BODY"));
	// Number keys address the shell tab list; "2" selects the first
	// observability sub-view (environments, traces, metrics, logs, topology).
	t.mockInput.pressKey("2");
	const frame = await t.waitForFrame(
		(value) => value.includes("Metrics") && value.includes("Traces"),
	);
	expect(frame).toContain("Topology");
	expect(frame).not.toContain("ENVIRONMENTS-BODY");
	t.renderer.destroy();
	db.close();
});

test("number keys select the visible Observability sub-tabs", async () => {
	const { t, db } = await renderUnifiedShell();
	await t.waitForFrame((value) => value.includes("ENVIRONMENTS-BODY"));
	// The feature row occupies 1-2; while Observability is visible its sub-row
	// follows: 3=Traces, 4=Metrics, 5=Logs, 6=Topology.
	t.mockInput.pressKey("2");
	await t.waitForFrame((value) => value.includes("Metrics"));
	t.mockInput.pressKey("4");
	const frame = await t.waitForFrame((value) =>
		value.includes("No metrics loaded"),
	);
	expect(frame).toContain("Metrics");
	t.renderer.destroy();
	db.close();
});

test("switching features keeps the live Environments body mounted", async () => {
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
	await t.waitForFrame((value) => value.includes("draft: retained"));
	expect(mounts).toBe(1);
	t.mockInput.pressKey("2");
	await t.waitForFrame((value) => value.includes("Metrics"));
	t.mockInput.pressKey("1");
	const frame = await t.waitForFrame((value) =>
		value.includes("draft: retained"),
	);
	expect(frame).toContain("draft: retained");
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
	const frame = await t.waitForFrame(
		(value) =>
			value.includes("Environments") && value.includes("Observability"),
	);
	expect(frame).toContain("ENVIRONMENTS-BODY");
	t.renderer.destroy();
	db.close();
});

test("hidden environment keymap layers do not consume visible feature keys", async () => {
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
	await t.waitForFrame((value) => value.includes("ENV-BODY"));
	// Switch to Observability
	t.mockInput.pressKey("2");
	await t.waitForFrame((value) => value.includes("Metrics"));
	// Send keys on Observability
	t.mockInput.pressKey("j");
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Metrics");
	t.renderer.destroy();
	db.close();
});

test("an open modal owns input across tab-switch keys", async () => {
	const { t, db } = await renderUnifiedShell();
	await t.waitForFrame((value) => value.includes("ENVIRONMENTS-BODY"));
	// Open help, then try to switch features with a number key. The top overlay
	// must keep input; the Environments body must not be replaced.
	t.mockInput.pressKey("?");
	await t.waitForFrame((value) => value.includes("Keybindings"));
	t.mockInput.pressKey("2");
	await t.renderOnce();
	// The help overlay still owns input; the feature did not switch underneath.
	expect(t.captureCharFrame()).toContain("Keybindings");
	// Close the overlay, then prove the Environments body is still the active
	// feature: if the number key had switched tabs, this would show traces.
	t.mockInput.pressKey("\u001b");
	await new Promise((resolve) => setTimeout(resolve, 80));
	const closed = await t.waitForFrame((value) =>
		value.includes("ENVIRONMENTS-BODY"),
	);
	expect(closed).toContain("Environments");
	t.renderer.destroy();
	db.close();
});
