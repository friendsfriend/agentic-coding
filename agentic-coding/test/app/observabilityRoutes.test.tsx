/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { TraceDb } from "../../src/server/telemetry-db";
import { App } from "../../src/tui/otel/app/App.tsx";
import { createDemoDb } from "../../src/tui/otel/model/demoDb.ts";
import { LogStore } from "../../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";
import {
	jumpTo,
	pressBack,
	pressEscapeAndSettle,
	renderUntil,
} from "./support/terminal.ts";

// Observability list/detail/span navigation on the shared route authority
// (replace-nested-tabs-with-page-navigation, task 2.3): the shell reports the
// location the route says, and Back returns to the previous location.

async function renderObservabilityShell() {
	const dir = mkdtempSync(join(tmpdir(), "otel-routes-"));
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
	return { t, db };
}

test("Enter opens the trace tree and Escape returns to the trace list", async () => {
	const { t, db } = await renderObservabilityShell();
	expect(t.captureCharFrame()).toContain("Traces");

	t.mockInput.pressEnter();
	expect(await renderUntil(t, "Span tree")).toBe(true);

	await pressEscapeAndSettle(t, (frame) => !frame.includes("Span tree"));
	const frame = t.captureCharFrame();
	expect(frame).toContain("search");
	expect(frame).not.toContain("Span tree");
	t.renderer.destroy();
	db.close();
});

test("the metric list opens a metric page and Escape goes back", async () => {
	const { t, db } = await renderObservabilityShell();
	await jumpTo(t, "metrics");
	t.mockInput.pressEnter();
	// Metric detail: the series panel replaces the list.
	expect(await renderUntil(t, "Data points")).toBe(true);

	await pressEscapeAndSettle(t, (frame) => !frame.includes("Data points"));
	expect(t.captureCharFrame()).not.toContain("Data points");
	t.renderer.destroy();
	db.close();
});

test("Back unwinds a cross-domain hop to the earlier trace tree", async () => {
	const { t, db } = await renderObservabilityShell();
	// Traces → trace tree (location A).
	t.mockInput.pressEnter();
	expect(await renderUntil(t, "Span tree")).toBe(true);
	// Cross to Metrics and open a metric (location B).
	await jumpTo(t, "metrics");
	t.mockInput.pressEnter();
	expect(await renderUntil(t, "Data points")).toBe(true);
	// Chronological Back unwinds the metric page, then the metrics list, then the
	// trace tree (Escape is the structural up-step instead).
	await pressBack(t, (frame) => !frame.includes("Data points"));
	expect(t.captureCharFrame()).not.toContain("Data points");
	await pressBack(t, (frame) => frame.includes("Span tree"));
	expect(t.captureCharFrame()).toContain("Span tree");
	t.renderer.destroy();
	db.close();
});
