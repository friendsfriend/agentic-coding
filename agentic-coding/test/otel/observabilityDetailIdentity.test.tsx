/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import { parseColor, type Renderable, TextRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { LogData, SpanData } from "../../src/contracts/telemetry.ts";
import { LogStore } from "../../src/tui/otel/model/logStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { LogDetailView } from "../../src/tui/otel/views/LogDetailView.tsx";
import { ServiceDetailView } from "../../src/tui/otel/views/ServiceDetailView.tsx";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

const span = (
	id: string,
	serviceName: string,
	parentSpanId = "",
	duration = 10,
	error = false,
): SpanData => ({
	spanId: id,
	serviceName,
	parentSpanId,
	traceId: "trace",
	name: id,
	kind: 0,
	startTimeUnixNano: "0",
	endTimeUnixNano: String(duration * 1_000_000),
	status: { code: error ? 2 : 0 },
	attributes: [],
	resource: { attributes: [], droppedAttributesCount: 0 },
	scope: { name: "test", version: "" },
});

test("service summary fields retain native nodes while values, error colors and dependencies refresh", async () => {
	const snapshot = (updated: boolean) => {
		const store = new TopologyStore();
		store.load([
			span("upstream", "gateway"),
			span("work", "worker", "upstream"),
			span("db", "database", "work"),
			...(updated
				? [
						span("more-work", "worker", "upstream", 20, true),
						span("cache", "cache", "work"),
					]
				: []),
		]);
		return store;
	};
	const [store, setStore] = createSignal(snapshot(false));
	const t = await testRender(
		() => <ServiceDetailView store={store()} id="worker" />,
		{ width: 100, height: 24 },
	);
	const text = (value: string) =>
		tree(t.renderer.root).find(
			(node) => node instanceof TextRenderable && node.plainText === value,
		);
	const field = (label: string) =>
		text(label)
			?.parent?.parent?.getChildren()
			.find((node) => node instanceof TextRenderable);
	try {
		await t.flush();
		const count = field("Spans"),
			errors = field("Errors"),
			duration = field("Avg duration");
		const dependency = text("gateway");
		if (
			!(count instanceof TextRenderable) ||
			!(errors instanceof TextRenderable) ||
			!(duration instanceof TextRenderable) ||
			!dependency
		)
			throw new Error("Missing service detail fields");
		setStore(snapshot(true));
		await t.renderOnce();
		for (const node of [count, errors, duration, dependency])
			expect(node.isDestroyed).toBe(false);
		expect(count.plainText).toBe("2");
		expect(errors.plainText).toBe("1");
		expect(Array.from(errors.fg.buffer)).toEqual(
			Array.from(parseColor(uiColors.error).buffer),
		);
		expect(duration.plainText).toBe("15.0ms");
		expect(t.captureCharFrame()).toContain("cache");
	} finally {
		t.renderer.destroy();
	}
});

test("log metadata and attribute fields stay mounted across replacement snapshots and reorder", async () => {
	const initial: LogData = {
		resource: { attributes: [] },
		scope: { name: "test", version: "" },
		serviceName: "worker",
		timeUnixNano: "1000000",
		severity: "INFO",
		body: "Before body",
		traceId: "trace-before",
		spanId: "span-before",
		attributes: [
			{ key: "route", value: "/before" },
			{ key: "result", value: "pending" },
		],
	};
	const [store, setStore] = createSignal(new LogStore([initial]));
	const t = await testRender(
		() => <LogDetailView store={store()} index={0} />,
		{ width: 100, height: 24 },
	);
	const text = (value: string) =>
		tree(t.renderer.root).find(
			(node) => node instanceof TextRenderable && node.plainText === value,
		);
	try {
		await t.flush();
		const route = text("/before"),
			result = text("pending"),
			trace = text("trace-before"),
			span = text("span-before");
		if (
			!(route instanceof TextRenderable) ||
			!(result instanceof TextRenderable) ||
			!(trace instanceof TextRenderable) ||
			!span
		)
			throw new Error("Missing log detail fields");
		const updated: LogData = {
			...initial,
			body: "After body",
			traceId: "trace-after",
			spanId: "span-after",
			attributes: [
				{ key: "result", value: "done" },
				{ key: "route", value: "/after" },
				{ key: "tag", value: "one" },
				{ key: "tag", value: "two" },
			],
		};
		setStore(new LogStore([updated]));
		await t.renderOnce();
		for (const node of [route, result, trace, span])
			expect(node.isDestroyed).toBe(false);
		expect(route.plainText).toBe("/after");
		expect(result.plainText).toBe("done");
		expect(trace.plainText).toBe("trace-after");
		expect(t.captureCharFrame()).toContain("span-after");
		expect(route.screenY).toBeGreaterThan(result.screenY);
		expect(
			tree(t.renderer.root).filter(
				(node) => node instanceof TextRenderable && node.plainText === "tag",
			),
		).toHaveLength(2);
		setStore(new LogStore([{ ...updated, spanId: undefined }]));
		await t.renderOnce();
		expect(span.isDestroyed).toBe(true);
		expect(trace.isDestroyed).toBe(false);
		expect(route.isDestroyed).toBe(false);
	} finally {
		t.renderer.destroy();
	}
});
