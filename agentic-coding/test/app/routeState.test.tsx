/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../../src/tui/otel/app/App";
import { TraceDb } from "../../src/tui/otel/model/db";
import { createDemoDb } from "../../src/tui/otel/model/demoDb";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";
import { crumb, jumpTo, renderUntil } from "./support/terminal";

// Route-local state (replace-nested-tabs-with-page-navigation, task 3.2):
// selection follows the selected resource identity, filters/search survive page
// changes, and a resource that disappeared falls back to its nearest valid
// ancestor with a diagnostic instead of showing another identity.

async function renderObservability() {
	const dir = mkdtempSync(join(tmpdir(), "route-state-"));
	const db = new TraceDb(dir);
	const { spans, metrics, logs } = await createDemoDb();
	const traceStore = new TraceStore();
	traceStore.loadFile(spans);
	const metricStore = new MetricStore();
	metricStore.load(metrics);
	const logStore = new LogStore();
	logStore.load(logs);
	const topologyStore = new TopologyStore();
	topologyStore.load(spans);
	const t = await testRender(
		() => (
			<App
				repos={["/demo"]}
				db={db}
				traceStore={traceStore}
				metricStore={metricStore}
				logStore={logStore}
				topologyStore={topologyStore}
			/>
		),
		{ width: 140, height: 40 },
	);
	await t.renderOnce();
	return { t, db, traceStore, metricStore };
}

test("a direct jump loads the resource the route names", async () => {
	const { t, db } = await renderObservability();
	// The picker offers the loaded traces by identity ("Loaded trace"), so
	// entering one loads that trace's tree rather than the plain list.
	await jumpTo(t, "loaded trace");
	const frame = t.captureCharFrame();
	expect(frame).toContain("Span tree");
	expect(crumb(t)).toContain("Observability › Traces");
	t.renderer.destroy();
	db.close();
});

test("search and filters survive leaving and returning to a page", async () => {
	const { t, db } = await renderObservability();
	// Filter the traces list, visit another destination, come back.
	t.mockInput.pressKey("/");
	await t.renderOnce();
	for (const character of "or") {
		t.mockInput.pressKey(character);
		await t.renderOnce();
	}
	t.mockInput.pressEnter();
	await t.renderOnce();
	const filtered = t.captureCharFrame();
	expect(filtered).toContain("/or");

	await jumpTo(t, "topology");
	expect(crumb(t)).toContain("Topology");
	await jumpTo(t, "traces");
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("/or");
	t.renderer.destroy();
	db.close();
});

test("a removed resource falls back to its ancestor with a diagnostic", async () => {
	const { t, db, traceStore } = await renderObservability();
	await t.mockInput.pressEnter();
	await t.renderOnce();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Span tree");

	// The data source drops the trace (refresh, retention, workspace switch).
	traceStore.loadFile([]);
	expect(await renderUntil(t, "no longer available")).toBe(true);
	const frame = t.captureCharFrame();
	// The fallback is the traces list, not a substituted trace.
	expect(frame).not.toContain("Span tree");
	expect(crumb(t)).toContain("Observability › Traces");
	t.renderer.destroy();
	db.close();
});

test("the destination cursor survives leaving and returning to Home", async () => {
	const dir = mkdtempSync(join(tmpdir(), "route-state-home-"));
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
				renderEnvironments={() => <text>ENV-BODY</text>}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.renderOnce();
	// Move the destination cursor down, open it, then go Back.
	t.mockInput.pressKey("j");
	await t.renderOnce();
	t.mockInput.pressEnter();
	await t.renderOnce();
	await t.renderOnce();
	const opened = crumb(t);
	t.mockInput.pressEscape();
	await new Promise((resolve) => setTimeout(resolve, 80));
	await t.renderOnce();
	await t.renderOnce();
	// The cursor is where it was, so Enter re-opens the same destination.
	t.mockInput.pressEnter();
	await t.renderOnce();
	await t.renderOnce();
	expect(crumb(t)).toBe(opened);
	t.renderer.destroy();
	db.close();
});
