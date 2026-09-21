/** @jsxImportSource @opentui/solid */
// Regression: opening a span detail from the trace tree must show the span's
// attributes instead of bouncing back with a "no longer available" toast. The
// span route names its span as `<traceId>:<spanId>` in the resource id, so the
// route availability and data loading have to resolve the trace identity from
// the route (the trace the view already has open), never from the composite.
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

/**
 * A span as the engine writes it: `workflowId` is mapped to the
 * `herdr.change.id` attribute (the trace list's grouping key) while the span
 * itself carries a stable hex trace id from its traceparent.
 */
function workflowSpan(
	changeId: string,
	traceId: string,
	spanId: string,
	name: string,
	parentSpanId = "",
): SpanData {
	// Recent timestamps: the shell runs retention when the trace list first
	// loads, so a 1970-era start time would be pruned before the view reads it.
	const start = (BigInt(Date.now() - 60_000) * 1_000_000n).toString();
	const end = (BigInt(Date.now()) * 1_000_000n).toString();
	return {
		traceId,
		spanId,
		parentSpanId,
		name,
		startTimeUnixNano: start,
		endTimeUnixNano: end,
		status: { code: 0 },
		attributes: [{ key: "herdr.change.id", value: changeId }],
		resource: { attributes: [], droppedAttributesCount: 0 },
		scope: { name: "engine", version: "" },
		serviceName: "herdr-workflow",
		kind: 0,
	};
}

test("selecting a span from the trace tree shows the span details", async () => {
	const dir = mkdtempSync(join(tmpdir(), "otel-span-route-"));
	const db = new TraceDb(dir);
	const changeId = "wf-0af7";
	const traceId = "0af7651916cd43dd8448eb211c80319c";
	db.ingestSpan(
		changeId,
		workflowSpan(changeId, traceId, "b2c1c2c3c4c5c6c7", "agent.operation"),
	);
	db.ingestSpan(
		changeId,
		workflowSpan(
			changeId,
			traceId,
			"d4e5f6a7b8c9d0e1",
			"effect.result",
			"b2c1c2c3c4c5c6c7",
		),
	);

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
		{ width: 120, height: 40 },
	);
	await t.renderOnce();
	// Keystrokes are processed by the render loop; settle between them so the
	// async span fetch (trace open) and route effects have rendered.
	const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

	// The trace list page loads after mount and shows the workflow row.
	await settle();
	expect(t.captureCharFrame()).toContain(changeId);

	// Open the trace: the tree renders its root span.
	t.mockInput.pressEnter();
	await settle();
	const treeFrame = t.captureCharFrame();
	expect(treeFrame).toContain("Span tree");

	// Select the first node (the virtual workflow root) to open its detail page.
	t.mockInput.pressEnter();
	await settle();
	const rootSpanFrame = t.captureCharFrame();
	expect(rootSpanFrame).toContain("Attributes");
	expect(rootSpanFrame).toContain("herdr.change.id");
	// The shell must not fall back with a "no longer available" toast.
	expect(rootSpanFrame).not.toContain("no longer available");

	// A real span (not the virtual tree root) opens the same way: back to the
	// tree, move to the first child, then open its detail page. The detail
	// page shows attributes, so the span identity comes from the breadcrumb
	// (`<traceId>:<spanId>` of the selected span).
	t.mockInput.pressEscape();
	await settle();
	expect(t.captureCharFrame()).toContain("Span tree");
	t.mockInput.pressKey("j");
	await t.renderOnce();
	t.mockInput.pressEnter();
	await settle();
	const realSpanFrame = t.captureCharFrame();
	expect(realSpanFrame).toContain("wf-0af7:b2c1c2c3c4c5c6c7");
	expect(realSpanFrame).toContain("Attributes");
	expect(realSpanFrame).not.toContain("no longer available");

	t.renderer.destroy();
	db.close();
});
