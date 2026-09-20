/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { runForeground } from "../../packages/devenv/cli/src/tui/actions/foreground.ts";
import { TraceDb } from "../../src/server/telemetry-db";
import { App } from "../../src/tui/otel/app/App.tsx";
import { createDemoDb } from "../../src/tui/otel/model/demoDb.ts";
import { LogStore } from "../../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";
import {
	activeWorkflowExecutions,
	disposeExecutionCoordinator,
	executionCoordinator,
} from "../../src/workflow/execution-coordinator.ts";
import { pressEscapeAndSettle, renderUntil } from "./support/terminal.ts";

// Page visibility never changes service ownership
// (replace-nested-tabs-with-page-navigation, task 3.3): navigating between
// pages neither creates nor releases a workflow coordinator, and the shell's
// telemetry stores keep their identity and content. A foreground utility keeps
// waiting asynchronously while pages change.

test("navigating pages does not create or release execution coordinators", async () => {
	const repo = "/tmp/herdr-page-ownership";
	const coordinator = executionCoordinator(repo);
	const dir = mkdtempSync(join(tmpdir(), "page-ownership-"));
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
	const spansBefore = traceStore.getTraceSummaries().length;

	const t = await testRender(
		() => (
			<App
				repos={[repo]}
				db={db}
				traceStore={traceStore}
				metricStore={metricStore}
				logStore={logStore}
				topologyStore={topologyStore}
				environments={{ serverUrl: "http://127.0.0.1:4050" }}
				renderEnvironments={() => <text>ENV-BODY</text>}
			/>
		),
		{ width: 120, height: 40 },
	);
	try {
		await t.renderOnce();
		// Environments category → feature body → Back, then across observability.
		// Every step asserts the frame it needs instead of counting renders.
		t.mockInput.pressEnter();
		expect(await renderUntil(t, "ENV-BODY")).toBe(true);
		await pressEscapeAndSettle(t, (frame) => frame.includes("Libraries"));
		t.mockInput.pressKey("p", { ctrl: true });
		expect(await renderUntil(t, "Locations")).toBe(true);
		for (const character of "metrics") {
			t.mockInput.pressKey(character);
			await t.renderOnce();
		}
		t.mockInput.pressEnter();
		expect(await renderUntil(t, (frame) => !frame.includes("Locations"))).toBe(
			true,
		);

		expect(executionCoordinator(repo)).toBe(coordinator);
		expect(activeWorkflowExecutions()).toEqual([]);
		// Telemetry owners keep their identity and loaded data.
		expect(traceStore.getTraceSummaries().length).toBe(spansBefore);
		expect(metricStore.getStreams().length).toBeGreaterThan(0);
	} finally {
		t.renderer.destroy();
		db.close();
		disposeExecutionCoordinator(repo);
	}
});

test("a foreground utility keeps waiting asynchronously while pages change", async () => {
	const dir = mkdtempSync(join(tmpdir(), "page-ownership-fg-"));
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
			/>
		),
		{ width: 100, height: 30 },
	);
	const ticks: number[] = [];
	try {
		// While the utility is pending, the shell keeps processing input and
		// timers: lease renewal and telemetry work do not wait for the child.
		const utility = runForeground("sh", ["-c", "sleep 0.2"], {
			renderer: {
				suspend: () => undefined,
				resume: () => undefined,
			},
		});
		const interval = setInterval(() => ticks.push(Date.now()), 10);
		t.mockInput.pressKey("j");
		await t.renderOnce();
		const code = await utility;
		clearInterval(interval);
		expect(code).toBe(0);
		expect(ticks.length).toBeGreaterThan(5);
	} finally {
		t.renderer.destroy();
		db.close();
	}
});
