/** @jsxImportSource @opentui/solid */
// The trace tree's pointer wiring (`tui-mouse-interaction`): the wheel moves the
// cursor through the flat index the view already knows, a tap on the selected
// row opens the span detail, and the expander glyph toggles the node without also
// dispatching `Enter`.
import { expect, test } from "bun:test";
import { ScrollableContent, uiColors } from "@agentic-coding/ui";
import { BoxRenderable, parseColor, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { TreeNode } from "../../src/contracts/telemetry.ts";
import { TraceTreeView } from "../../src/tui/otel/views/TraceTreeView.tsx";

let spanCounter = 0;
const node = (
	name: string,
	children: TreeNode[] = [],
	expanded = false,
): TreeNode =>
	({
		span: {
			name,
			traceId: "trace",
			spanId: `span-${spanCounter++}`,
			scope: { name: "tracer" },
			status: { code: 1, message: "" },
			startTimeUnixNano: "0",
			endTimeUnixNano: "1000000",
			attributes: [],
		},
		children,
		expanded,
	}) as unknown as TreeNode;

const roots = (): TreeNode[] => [
	node("root", [node("child-a"), node("child-b")], true),
	node("second"),
];

function renderTree(item: Renderable): Renderable[] {
	return [item, ...item.getChildren().flatMap(renderTree)];
}

test("live trace snapshots preserve row hover while labels, timing, status and current paths update", async () => {
	const initial = roots();
	const watched = initial[0]?.children[0];
	if (!watched) throw new Error("Missing fixture span");
	const [snapshot, setSnapshot] = createSignal(initial);
	const selected: number[][] = [];
	const toggled: { node: TreeNode; path: number[] }[] = [];
	const t = await testRender(
		() => (
			<TraceTreeView
				roots={snapshot}
				selectedIndex={() => -1}
				onSelect={(path) => selected.push(path)}
				onToggle={(node, path) => toggled.push({ node, path })}
			/>
		),
		{ width: 120, height: 18 },
	);
	const rowY = (name: string) =>
		t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes(name));
	const background = (name: string) => {
		const span = t
			.captureSpans()
			.lines.flatMap((line) => line.spans)
			.find((span) => span.text.includes(name));
		if (!span) throw new Error(`Missing span ${name}`);
		return Array.from(span.bg.buffer);
	};
	try {
		await t.flush();
		await t.mockMouse.moveTo(20, rowY("child-a"));
		await t.flush();
		const surface = renderTree(t.renderer.root).find(
			(item) =>
				item instanceof BoxRenderable &&
				item.height === 1 &&
				item.backgroundColor.equals(parseColor(uiColors.bgHover)),
		);
		if (!surface) throw new Error("Missing hovered span row");
		setSnapshot((current) =>
			current.map((root, index) => ({
				...root,
				span: {
					...root.span,
					endTimeUnixNano: index === 0 ? "20000000" : root.span.endTimeUnixNano,
				},
				children: root.children.map((child) =>
					child.span.spanId === watched.span.spanId
						? {
								...child,
								span: {
									...child.span,
									name: "updated-child",
									endTimeUnixNano: "5000000",
									status: { code: 2, message: "failure" },
								},
								children: [node("nested-child")],
								expanded: false,
							}
						: { ...child },
				),
			})),
		);
		await t.renderOnce();
		expect(surface.isDestroyed).toBe(false);
		expect(background("updated-child")).toEqual(
			Array.from(parseColor(uiColors.bgHover).buffer),
		);
		const line = t.captureCharFrame().split("\n")[rowY("updated-child")] ?? "";
		expect(line).toContain("5ms");
		expect(line).toContain("25.0%");
		expect(line).toContain("▶");
		const durationSpan = t
			.captureSpans()
			.lines.flatMap((line) => line.spans)
			.find((span) => span.text.includes("5ms"));
		expect(durationSpan ? Array.from(durationSpan.fg.buffer) : []).toEqual(
			Array.from(parseColor(uiColors.error).buffer),
		);
		setSnapshot((current) => [
			node("new-root"),
			...current.map((root) => ({
				...root,
				children: [...root.children].reverse(),
			})),
		]);
		await t.flush();
		expect(surface.isDestroyed).toBe(false);
		await t.mockMouse.click(30, rowY("updated-child"));
		await t.flush();
		expect(selected.at(-1)).toEqual([1, 1]);
		await t.mockMouse.click(3, rowY("updated-child"));
		await t.flush();
		expect(toggled.at(-1)?.path).toEqual([1, 1]);
		expect(toggled.at(-1)?.node).toBe(snapshot()[1]?.children[1]);
		expect(toggled.at(-1)?.node.span.name).toBe("updated-child");
	} finally {
		t.renderer.destroy();
	}
});

test("the wheel moves the tree cursor by index, and stops at both ends", async () => {
	const moved: number[] = [];
	const [cursor, setCursor] = createSignal(0);
	const t = await testRender(
		() => (
			<TraceTreeView
				roots={roots}
				selectedIndex={cursor}
				onToggle={() => {}}
				onSelect={() => {}}
				onSelectIndex={(index) => {
					moved.push(index);
					setCursor(index);
				}}
			/>
		),
		{ width: 120, height: 12 },
	);
	await t.flush();
	// Four visible nodes: root, its two children and the second root.
	await t.mockMouse.scroll(6, 1, "down");
	await t.flush();
	expect(moved.at(-1)).toBe(1);
	await t.mockMouse.scroll(6, 1, "down");
	await t.flush();
	expect(moved.at(-1)).toBe(2);
	await t.mockMouse.scroll(6, 1, "down");
	await t.flush();
	expect(moved.at(-1)).toBe(3);
	// The end clamps: no further move.
	await t.mockMouse.scroll(6, 1, "down");
	await t.flush();
	expect(moved.at(-1)).toBe(3);
	t.renderer.destroy();
});

test("an empty tree lets the wheel reach the scroll owner around it", async () => {
	let box: import("@opentui/core").ScrollBoxRenderable | undefined;
	const moved: number[] = [];
	const t = await testRender(
		() => (
			<box width="100%" height="100%" flexDirection="column">
				<ScrollableContent
					style={{ height: 6 }}
					onScrollBoxReady={(ready) => {
						box = ready;
					}}
				>
					<TraceTreeView
						roots={() => []}
						selectedIndex={() => 0}
						onToggle={() => {}}
						onSelect={() => {}}
						onSelectIndex={(index) => moved.push(index)}
					/>
					{Array.from({ length: 30 }, (_, index) => (
						<text>{`filler ${index}`}</text>
					))}
				</ScrollableContent>
			</box>
		),
		{ width: 120, height: 14 },
	);
	await t.flush();
	expect(box).toBeDefined();
	expect(box?.scrollTop ?? 0).toBe(0);
	// `enabled` is false on an empty tree, so the event bubbles to the box.
	for (let notch = 0; notch < 4; notch += 1)
		await t.mockMouse.scroll(6, 1, "down");
	await t.flush();
	expect(box?.scrollTop ?? 0).toBeGreaterThan(0);
	expect(moved).toEqual([]);
	t.renderer.destroy();
});

test("a tap selects a row and a tap on the selected row opens the span", async () => {
	const opened: string[] = [];
	const selected: string[] = [];
	const [cursor, setCursor] = createSignal(1);
	const t = await testRender(
		() => (
			<TraceTreeView
				roots={roots}
				selectedIndex={cursor}
				onToggle={() => {}}
				onSelect={(path) => {
					selected.push(path.join("."));
					setCursor(path[0] ?? 0);
				}}
				onSelectIndex={setCursor}
			/>
		),
		{ width: 120, height: 12 },
	);
	const { createDefaultOpenTuiKeymap } = await import(
		"@opentui/keymap/opentui"
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		name: "probe",
		commands: [
			{
				name: "probe.openSpan",
				context: "global",
				run: () => {
					opened.push("enter");
					return true;
				},
			},
		],
		bindings: [
			{ key: "enter", cmd: "probe.openSpan" },
			{ key: "return", cmd: "probe.openSpan" },
		],
	});
	await t.flush();
	// The first tree row is not the cursor (which starts on the second): the tap
	// selects it through the view's own selection path and nothing opens.
	await t.mockMouse.click(40, 0);
	await t.flush();
	expect(selected.at(-1)).toBe("0");
	expect(opened).toEqual([]);
	// A tap on the already-selected row dispatches the view's `Enter`.
	await t.mockMouse.click(40, 0);
	await t.flush();
	expect(opened).toEqual(["enter"]);
	// Parity: the key reaches the same command.
	t.mockInput.pressEnter();
	await t.flush();
	expect(opened).toEqual(["enter", "enter"]);
	t.renderer.destroy();
});

test("the expander glyph toggles the node and does not also open the span", async () => {
	const toggled: number[] = [];
	const opened: string[] = [];
	const t = await testRender(
		() => (
			<TraceTreeView
				roots={roots}
				selectedIndex={() => 0}
				onToggle={(item) => toggled.push(item.span ? 1 : 1)}
				onSelect={(path) => opened.push(path.join("."))}
			/>
		),
		{ width: 120, height: 12 },
	);
	const { createDefaultOpenTuiKeymap } = await import(
		"@opentui/keymap/opentui"
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		name: "probe",
		commands: [
			{
				name: "probe.openSpan",
				context: "global",
				run: () => {
					opened.push("enter");
					return true;
				},
			},
		],
		bindings: [
			{ key: "enter", cmd: "probe.openSpan" },
			{ key: "return", cmd: "probe.openSpan" },
		],
	});
	await t.flush();
	// The glyph is the first row's expander: the row chrome (marker + gap) puts
	// it two columns in.
	await t.mockMouse.click(3, 0);
	await t.flush();
	expect(toggled.length).toBe(1);
	// One action per gesture: the glyph consumed the tap, so no `Enter` ran.
	expect(opened).toEqual(["0"]);
	t.renderer.destroy();
});
