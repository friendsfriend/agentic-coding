/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import { BoxRenderable, parseColor, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { MetricData } from "../../src/contracts/telemetry.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { MetricsView } from "../../src/tui/otel/views/MetricsView.tsx";

const metric = (
	name: string,
	serviceName: string,
	values: number[],
): MetricData => ({
	name,
	serviceName,
	type: "gauge",
	unit: "%",
	description: "",
	resource: { attributes: [] },
	scope: { name: "test", version: "" },
	dataPoints: values.map((value, index) => ({
		value,
		timeUnixNano: String(index + 1),
		startTimeUnixNano: "0",
		attributes: [],
	})),
});

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

test("metric rows retain hover and sparklines while samples, aggregates and sort order change", async () => {
	const snapshot = (values: number[]) =>
		new MetricStore([
			metric("cpu", "web", values),
			metric("memory", "db", [5, 4, 5]),
		]);
	const [store, setStore] = createSignal(snapshot([1, 2, 3]));
	const [selected, setSelected] = createSignal(-1);
	const opened: string[] = [];
	const t = await testRender(
		() => (
			<MetricsView
				store={store()}
				selectedIndex={selected}
				onSelectIndex={setSelected}
				onOpen={(name, service) => opened.push(`${service}/${name}`)}
			/>
		),
		{ width: 100, height: 18 },
	);
	const rowY = () =>
		t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes("cpu"));
	const chartFrame = () =>
		t
			.captureCharFrame()
			.split("\n")
			.slice(rowY() + 1, rowY() + 3)
			.join("\n");
	try {
		await t.flush();
		await t.mockMouse.moveTo(5, rowY());
		await t.flush();
		const marker = tree(t.renderer.root).find(
			(node) =>
				node instanceof BoxRenderable &&
				node.width === 1 &&
				node.height === 3 &&
				node.backgroundColor.equals(parseColor(uiColors.borderFocus)),
		);
		if (!(marker instanceof BoxRenderable) || !marker.parent)
			throw new Error("Missing hovered metric row");
		const card = marker.parent;
		const chart = tree(card).find(
			(node) =>
				node instanceof BoxRenderable &&
				node.height === 2 &&
				node.renderAfter !== undefined,
		);
		if (!chart) throw new Error("Missing metric sparkline");
		const before = chartFrame();
		// Same average, different graph: chart invalidation must not depend on a
		// changing label or on replacing the chart's native renderable.
		setStore(snapshot([3, 2, 1]));
		await t.renderOnce();
		expect(card.isDestroyed).toBe(false);
		expect(chart.isDestroyed).toBe(false);
		expect(marker.backgroundColor).toEqual(parseColor(uiColors.borderFocus));
		expect(chartFrame()).not.toBe(before);
		setStore(snapshot([6, 12]));
		await t.renderOnce();
		expect(card.isDestroyed).toBe(false);
		expect(t.captureCharFrame().split("\n")[rowY()]).toContain("9.00");
		const sorted = snapshot([6, 12]);
		sorted.setSort("service");
		setStore(sorted);
		await t.flush();
		expect(card.isDestroyed).toBe(false);
		expect(chart.isDestroyed).toBe(false);
		await t.mockMouse.click(5, rowY());
		await t.flush();
		expect(selected()).toBe(1);
		expect(opened).toHaveLength(0);
		await t.mockMouse.click(5, rowY());
		await t.flush();
		expect(opened).toEqual(["web/cpu"]);
	} finally {
		t.renderer.destroy();
	}
});

test("duplicate metric identities retain separate rows", async () => {
	const [store, setStore] = createSignal(
		new MetricStore([metric("cpu", "web", [1]), metric("cpu", "web", [2])]),
	);
	const t = await testRender(
		() => (
			<MetricsView
				store={store()}
				selectedIndex={() => -1}
				onSelectIndex={() => {}}
				onOpen={() => {}}
			/>
		),
		{ width: 100, height: 18 },
	);
	try {
		await t.flush();
		setStore(
			new MetricStore([metric("cpu", "web", [3]), metric("cpu", "web", [4])]),
		);
		await t.renderOnce();
		expect(t.captureCharFrame().match(/cpu/g)).toHaveLength(2);
		expect(t.captureCharFrame()).toContain("3.00");
		expect(t.captureCharFrame()).toContain("4.00");
	} finally {
		t.renderer.destroy();
	}
});
