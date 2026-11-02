/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import { BoxRenderable, parseColor, type Renderable } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { TopologyGraph } from "../../src/tui/otel/components/TopologyGraph.tsx";
import type { LayoutNode } from "../../src/tui/otel/model/topologyStore.ts";

const service = (id: string, layer: number, slot: number): LayoutNode => ({
	id,
	layer,
	slot,
	node: {
		id,
		parentIds: [],
		childIds: [],
		spanCount: 1,
		errorCount: 0,
		avgDurationMs: 1,
	},
});

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

test("topology layers and service cards survive live snapshots, sibling reordering and added layers", async () => {
	const [layout, setLayout] = createSignal([
		service("svc-a", 0, 0),
		service("svc-b", 0, 1),
		service("svc-c", 1, 0),
	]);
	const [selected, setSelected] = createSignal<string>();
	const opened: (string | undefined)[] = [];
	const t = await testRender(
		() => (
			<TopologyGraph
				layout={layout}
				selected={selected}
				onSelect={setSelected}
			/>
		),
		{ width: 100, height: 18 },
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		commands: [
			{
				name: "test.open-service",
				context: "global",
				run: () => {
					opened.push(selected());
					return true;
				},
			},
		],
		bindings: [
			{ key: "enter", cmd: "test.open-service" },
			{ key: "return", cmd: "test.open-service" },
		],
	});
	const location = () => {
		const lines = t.captureCharFrame().split("\n");
		const y = lines.findIndex((line) => line.includes("svc-a"));
		const x = (lines[y] ?? "").indexOf("svc-a");
		if (x < 0 || y < 0) throw new Error("Missing service card");
		return { x: x + 1, y };
	};
	try {
		await t.flush();
		let point = location();
		await t.mockMouse.moveTo(point.x, point.y);
		await t.flush();
		const marker = tree(t.renderer.root).find(
			(node) =>
				node instanceof BoxRenderable &&
				node.width === 1 &&
				node.height === 3 &&
				node.backgroundColor.equals(parseColor(uiColors.borderFocus)),
		);
		if (!(marker instanceof BoxRenderable))
			throw new Error("Missing hovered service marker");
		const card = marker.parent;
		if (!card) throw new Error("Missing service card parent");
		for (const count of [2, 5]) {
			setLayout((current) =>
				current.map((item) => ({
					...item,
					node: {
						...item.node,
						...(item.id === "svc-a"
							? { spanCount: count, errorCount: 2, avgDurationMs: 9.5 }
							: {}),
					},
				})),
			);
			await t.renderOnce();
			expect(card.isDestroyed).toBe(false);
			expect(marker.isDestroyed).toBe(false);
			expect(marker.backgroundColor).toEqual(parseColor(uiColors.borderFocus));
			expect(t.captureCharFrame()).toContain(`${count} spans · 9.5ms`);
			expect(t.captureCharFrame()).toContain("2 errors");
		}
		setLayout((current) => [
			service("new-layer", -1, 0),
			...current.slice(0, 2).reverse(),
			...current.slice(2),
		]);
		await t.flush();
		expect(card.isDestroyed).toBe(false);
		expect(marker.isDestroyed).toBe(false);
		expect(t.captureCharFrame()).toContain("Layer -1");
		point = location();
		await t.mockMouse.click(point.x, point.y);
		await t.flush();
		expect(selected()).toBe("svc-a");
		expect(opened).toHaveLength(0);
		await t.mockMouse.click(point.x, point.y);
		await t.flush();
		expect(opened).toEqual(["svc-a"]);
		setLayout((current) => current.filter((item) => item.id !== "svc-a"));
		await t.flush();
		expect(card.isDestroyed).toBe(true);
	} finally {
		t.renderer.destroy();
	}
});
