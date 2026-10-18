/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import type { SpanData } from "../../src/contracts/telemetry.ts";
import { TraceDb } from "../../src/server/telemetry-db";
import { App } from "../../src/tui/otel/app/App.tsx";
import { LogStore } from "../../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";
import { advance } from "../app/support/terminal.ts";

function span(workspace: string, id: string): SpanData {
	return {
		traceId: "0af7651916cd43dd8448eb211c80319c",
		spanId: id.padStart(16, "0"),
		parentSpanId: "",
		name: "effect.result",
		startTimeUnixNano: "1000000",
		endTimeUnixNano: "2000000",
		status: { code: 0 },
		attributes: [{ key: "herdr.change.id", value: workspace }],
		resource: { attributes: [], droppedAttributesCount: 0 },
		scope: { name: "engine", version: "" },
		serviceName: "herdr-workflow",
		kind: 0,
	};
}

test("traces tab reflects store loads and live pushes after mount", async () => {
	const dir = mkdtempSync(join(tmpdir(), "otel-live-refresh-"));
	const db = new TraceDb(dir);
	const traceStore = new TraceStore();
	const t = await testRender(
		() => (
			<App
				repos={["/demo"]}
				db={db}
				traceStore={traceStore}
				metricStore={new MetricStore()}
				logStore={new LogStore()}
				topologyStore={new TopologyStore()}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.renderOnce();

	// The shell loads history after mount; the view must refresh from the store.
	traceStore.loadFile([span("initial-wf", "a1")]);
	await t.waitForFrame((value) => value.includes("initial-wf"));

	// Live OTLP receiver pushes use the same path. The store coalesces its
	// notification per window (fix-tui-freezes-and-memory), so the frame lands
	// after that wall-clock window rather than on the next render pass.
	traceStore.pushBatch([span("live-wf", "b2")]);
	await advance(t, 4, 60);
	expect(t.captureCharFrame()).toContain("live-wf");

	t.renderer.destroy();
	db.close();
});
