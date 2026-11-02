/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { type Renderable, TextRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { MetricData } from "../../src/contracts/telemetry.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { MetricDetailView } from "../../src/tui/otel/views/MetricDetailView.tsx";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

function metric(
	values = [10, 20],
	counts = [8, 1],
	bounds = [10, 20],
): MetricData {
	return {
		name: "latency",
		serviceName: "web",
		type: "histogram",
		unit: "ms",
		description: "",
		resource: { attributes: [] },
		scope: { name: "test", version: "" },
		dataPoints: values.map((value, index) => ({
			value,
			startTimeUnixNano: "0",
			timeUnixNano: String((index + 1) * 1_000_000),
			bucketCounts: [...counts],
			explicitBounds: [...bounds],
			attributes: [
				{ key: "zone", value: "west" },
				{ key: "host", value: String(index) },
			],
		})),
	};
}

test("metric detail retains summary, histogram and data-point renderers while their values update", async () => {
	const [store, setStore] = createSignal(new MetricStore([metric()]));
	const t = await testRender(
		() => <MetricDetailView store={store()} name="latency" serviceName="web" />,
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		const averageLabel = tree(t.renderer.root).find(
			(node) => node instanceof TextRenderable && node.plainText === "Avg",
		);
		const bound = tree(t.renderer.root).find(
			(node) => node instanceof TextRenderable && node.plainText === "10",
		);
		const value = tree(t.renderer.root).find(
			(node) =>
				node instanceof TextRenderable &&
				node.plainText === "10.00" &&
				node.parent?.width === 12,
		);
		if (
			!(averageLabel instanceof TextRenderable) ||
			!(bound instanceof TextRenderable) ||
			!(value instanceof TextRenderable)
		)
			throw new Error("Missing metric detail fixtures");
		const average = averageLabel.parent
			?.getChildren()
			.find((node) => node instanceof TextRenderable && node !== averageLabel);
		const bar = bound.parent
			?.getChildren()
			.find((node) => node instanceof TextRenderable && node !== bound);
		if (
			!(average instanceof TextRenderable) ||
			!(bar instanceof TextRenderable)
		)
			throw new Error("Missing aggregate or bucket value");
		expect(average.plainText).toBe("15.00");
		expect(bar.plainText).toBe("▓");
		const updated = metric([30, 40], [1, 8], [11, 21]);
		for (const point of updated.dataPoints) point.attributes.reverse();
		setStore(new MetricStore([updated]));
		await t.renderOnce();
		expect(average.isDestroyed).toBe(false);
		expect(bound.isDestroyed).toBe(false);
		expect(bar.isDestroyed).toBe(false);
		expect(value.isDestroyed).toBe(false);
		expect(average.plainText).toBe("35.00");
		expect(bound.plainText).toBe("11");
		expect(bar.plainText).toBe("░");
		expect(value.plainText).toBe("30.00");
		const row = value.parent?.parent;
		if (!row) throw new Error("Missing sample row");
		setStore(
			new MetricStore([
				{
					...updated,
					dataPoints: [...updated.dataPoints]
						.reverse()
						.map((point) => ({ ...point })),
				},
			]),
		);
		await t.renderOnce();
		expect(row.isDestroyed).toBe(false);
		expect(value.isDestroyed).toBe(false);
		const index = tree(row).find(
			(node) => node instanceof TextRenderable && /^2\s*$/.test(node.plainText),
		);
		expect(index).toBeDefined();
	} finally {
		t.renderer.destroy();
	}
});

test("metric data-point identity distinguishes attributes and preserves duplicate occurrences", async () => {
	const first = metric([10]);
	const point = first.dataPoints[0];
	if (!point) throw new Error("Missing point fixture");
	first.dataPoints.push({
		...point,
		value: 20,
		attributes: [{ key: "host", value: "other" }],
	});
	first.dataPoints.push({ ...point, value: 30 });
	const t = await testRender(
		() => (
			<MetricDetailView
				store={new MetricStore([first])}
				name="latency"
				serviceName="web"
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		const cells = tree(t.renderer.root).filter(
			(node) => node instanceof TextRenderable && node.parent?.width === 12,
		);
		expect(cells).toHaveLength(3);
		expect(cells.map((node) => (node as TextRenderable).plainText)).toEqual([
			"10.00",
			"20.00",
			"30.00",
		]);
	} finally {
		t.renderer.destroy();
	}
});
