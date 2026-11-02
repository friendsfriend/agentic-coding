/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { ScrollableList, SelectableList, uiColors } from "@agentic-coding/ui";
import { BoxRenderable, parseColor, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

for (const variable of [false, true]) {
	test(`reactive list rows retain hover and content through refresh and reorder (${variable ? "variable" : "uniform"} heights)`, async () => {
		const [items, setItems] = createSignal([
			{ id: "a", label: "Alpha" },
			{ id: "b", label: "Beta" },
		]);
		const [selected, setSelected] = createSignal(-1);
		let mounts = 0;
		const t = await testRender(
			() => (
				<ScrollableList
					items={items()}
					itemKey={(item) => item.id}
					selectedIndex={selected()}
					onSelect={setSelected}
					availableLines={8}
					showScrollIndicator={false}
					itemHeights={variable ? items().map(() => 1) : undefined}
					renderItem={(item) => <text>{item.label}</text>}
					renderReactiveItem={(item, _selected, index) => {
						mounts++;
						return (
							<text>
								{item().label}:{index()}
							</text>
						);
					}}
				/>
			),
			{ width: 40, height: 10 },
		);
		const background = (label: string) => {
			const span = t
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.find((span) => span.text.includes(label));
			if (!span) throw new Error(`Missing row ${label}`);
			return Array.from(span.bg.buffer);
		};
		try {
			await t.renderOnce();
			await t.mockMouse.moveTo(4, 0);
			await t.renderOnce();
			const hovered = tree(t.renderer.root).find(
				(node) =>
					node instanceof BoxRenderable &&
					node.backgroundColor.equals(parseColor(uiColors.bgHover)),
			);
			if (!hovered) throw new Error("Missing hovered row");
			const color = Array.from(parseColor(uiColors.bgHover).buffer);
			expect(background("Alpha")).toEqual(color);
			setItems([
				{ id: "a", label: "Alpha updated" },
				{ id: "b", label: "Beta updated" },
			]);
			await t.renderOnce();
			expect(hovered.isDestroyed).toBe(false);
			expect(background("Alpha updated")).toEqual(color);
			expect(mounts).toBe(2);
			setSelected(1);
			await t.renderOnce();
			expect(hovered.isDestroyed).toBe(false);
			expect(mounts).toBe(2);
			setItems((current) => [...current].reverse());
			await t.renderOnce();
			expect(hovered.isDestroyed).toBe(false);
			expect(mounts).toBe(2);
			expect(t.captureCharFrame()).toContain("Alpha updated:1");
			setSelected(-1);
			await t.renderOnce();
			await t.mockMouse.click(4, 1);
			await t.renderOnce();
			expect(selected()).toBe(1);
		} finally {
			t.renderer.destroy();
		}
	});
}

test("SelectableList retains its selection/hover surface while legacy item content refreshes", async () => {
	const [items, setItems] = createSignal([{ id: "a", label: "Before" }]);
	const t = await testRender(
		() => (
			<SelectableList
				items={items()}
				itemKey={(item) => item.id}
				selectedIndex={-1}
				onSelect={() => {}}
				availableLines={6}
				renderItem={(item) => <text>{item.label}</text>}
			/>
		),
		{ width: 30, height: 8 },
	);
	try {
		await t.renderOnce();
		await t.mockMouse.moveTo(4, 0);
		await t.renderOnce();
		const surface = tree(t.renderer.root).find(
			(node) =>
				node instanceof BoxRenderable &&
				node.backgroundColor.equals(parseColor(uiColors.bgHover)),
		);
		if (!surface) throw new Error("Missing selectable surface");
		setItems([{ id: "a", label: "After" }]);
		await t.renderOnce();
		expect(surface.isDestroyed).toBe(false);
		expect(t.captureCharFrame()).toContain("After");
		expect((surface as BoxRenderable).backgroundColor).toEqual(
			parseColor(uiColors.bgHover),
		);
	} finally {
		t.renderer.destroy();
	}
});

test("default reference keys do not recreate rows when a variable-height window recomputes", async () => {
	const first = { label: "First" };
	const second = { label: "Second" };
	const [items, setItems] = createSignal([first, second]);
	const [selected, setSelected] = createSignal(0);
	let mounts = 0;
	const t = await testRender(
		() => (
			<ScrollableList
				items={items()}
				selectedIndex={selected()}
				onSelect={setSelected}
				availableLines={6}
				itemHeights={items().map(() => 1)}
				showScrollIndicator={false}
				renderItem={(item) => <text>{item.label}</text>}
				renderReactiveItem={(item) => {
					mounts++;
					return <text>{item().label}</text>;
				}}
			/>
		),
		{ width: 30, height: 8 },
	);
	try {
		await t.renderOnce();
		setSelected(1);
		setItems([first, second]);
		await t.renderOnce();
		expect(mounts).toBe(2);
		setItems([first]);
		await t.renderOnce();
		setItems([first, second]);
		await t.renderOnce();
		expect(mounts).toBe(3);
	} finally {
		t.renderer.destroy();
	}
});

test("duplicate primitive items retain separate row occurrences", async () => {
	const [items, setItems] = createSignal(["duplicate", "duplicate"]);
	let mounts = 0;
	const t = await testRender(
		() => (
			<ScrollableList
				items={items()}
				selectedIndex={-1}
				availableLines={6}
				showScrollIndicator={false}
				renderItem={(item) => <text>{item}</text>}
				renderReactiveItem={(item) => {
					mounts++;
					return <text>{item()}</text>;
				}}
			/>
		),
		{ width: 30, height: 8 },
	);
	try {
		await t.renderOnce();
		setItems(["duplicate", "duplicate"]);
		await t.renderOnce();
		expect(mounts).toBe(2);
		expect(t.captureCharFrame().match(/duplicate/g)).toHaveLength(2);
	} finally {
		t.renderer.destroy();
	}
});
