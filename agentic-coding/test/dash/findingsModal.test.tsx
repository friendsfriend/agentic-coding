/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import {
	BoxRenderable,
	MarkdownRenderable,
	parseColor,
	type Renderable,
	type ScrollBoxRenderable,
	TextRenderable,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { batch, createSignal } from "solid-js";
import {
	type FindingEvent,
	FindingsModal,
} from "../../src/tui/dash/ui/FindingsModal.tsx";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

test("finding rows retain hover and current selection indices while severity and detail refresh", async () => {
	const [events, setEvents] = createSignal<FindingEvent[]>([
		{
			id: "one",
			type: "finding",
			severity: "warning",
			detail: "First issue",
			path: "first.ts",
			verifier: "worker",
		},
		{
			id: "two",
			type: "finding",
			severity: "info",
			detail: "Second issue",
			path: "second.ts",
			verifier: "worker",
		},
	]);
	const selected: number[] = [];
	const t = await testRender(
		() => (
			<FindingsModal
				title="Findings"
				events={events()}
				selected={-1}
				onSelectIndex={(index) => selected.push(index)}
				onDetailScrollBoxReady={() => {}}
			/>
		),
		{ width: 140, height: 40 },
	);
	const rowY = () =>
		t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes("first.ts"));
	try {
		await t.flush();
		await t.mockMouse.moveTo(25, rowY());
		await t.flush();
		const surface = tree(t.renderer.root).find(
			(node) =>
				node instanceof BoxRenderable &&
				node.backgroundColor.equals(parseColor(uiColors.bgHover)),
		);
		const detail = tree(t.renderer.root).find(
			(node) =>
				node instanceof TextRenderable && node.plainText === "First issue",
		);
		if (
			!(surface instanceof BoxRenderable) ||
			!(detail instanceof TextRenderable)
		)
			throw new Error("Missing hovered finding");
		setEvents((current) =>
			current.map((event) => ({
				...event,
				...(event.id === "one"
					? { severity: "critical", detail: "Updated first issue" }
					: {}),
			})),
		);
		await t.renderOnce();
		expect(surface.isDestroyed).toBe(false);
		expect(detail.isDestroyed).toBe(false);
		expect(detail.plainText).toBe("Updated first issue");
		expect(surface.backgroundColor).toEqual(parseColor(uiColors.bgHover));
		expect(t.captureCharFrame()).toContain("FAIL");
		setEvents((current) => [...current].reverse());
		await t.flush();
		expect(surface.isDestroyed).toBe(false);
		await t.mockMouse.click(25, rowY());
		await t.flush();
		expect(selected).toEqual([1]);
	} finally {
		t.renderer.destroy();
	}
});

test("finding detail scroll resets only on a different finding, not snapshot replacement or reorder", async () => {
	const body = Array.from(
		{ length: 60 },
		(_, index) => `Evidence paragraph ${index}.`,
	).join("\n\n");
	const [events, setEvents] = createSignal<FindingEvent[]>([
		{
			id: "one",
			type: "finding",
			severity: "warning",
			path: "same.ts",
			detail: body,
		},
		{
			id: "two",
			type: "finding",
			severity: "warning",
			path: "same.ts",
			detail: body,
		},
	]);
	const [selected, setSelected] = createSignal(0);
	let scroll: ScrollBoxRenderable | undefined;
	const t = await testRender(
		() => (
			<FindingsModal
				title="Findings"
				events={events()}
				selected={selected()}
				onDetailScrollBoxReady={(box) => {
					scroll = box;
				}}
			/>
		),
		{ width: 140, height: 40 },
	);
	try {
		await t.flush();
		for (
			let attempt = 0;
			attempt < 50 &&
			(!scroll || scroll.scrollHeight <= scroll.viewport.height);
			attempt++
		) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			await t.flush();
		}
		if (!scroll) throw new Error("Missing finding scrollbox");
		scroll.scrollTop = 5;
		await t.flush();
		expect(scroll.scrollTop).toBe(5);
		const markdown = tree(t.renderer.root).find(
			(node) => node instanceof MarkdownRenderable,
		);
		if (!(markdown instanceof MarkdownRenderable))
			throw new Error("Missing finding Markdown");
		setEvents((current) =>
			current.map((event) => ({ ...event, severity: "critical" })),
		);
		await t.flush();
		expect(scroll.scrollTop).toBe(5);
		expect(markdown.isDestroyed).toBe(false);
		setEvents((current) =>
			current.map((event) => ({
				...event,
				recommendation: "Use the safer path",
			})),
		);
		await t.flush();
		expect(scroll.scrollTop).toBe(5);
		expect(markdown.isDestroyed).toBe(false);
		expect(markdown.content).toContain("Use the safer path");
		batch(() => {
			setEvents((current) => [...current].reverse());
			setSelected(1);
		});
		await t.flush();
		expect(scroll.scrollTop).toBe(5);
		expect(markdown.isDestroyed).toBe(false);
		setSelected(0);
		await t.flush();
		expect(scroll.scrollTop).toBe(0);
	} finally {
		t.renderer.destroy();
	}
});

test("finding renders verifier, markdown detail, and markdown recommendation", async () => {
	const t = await testRender(
		() => (
			<FindingsModal
				title="Verifier findings"
				selected={0}
				onDetailScrollBoxReady={() => {}}
				events={[
					{
						type: "finding",
						severity: "warning",
						verifier: "security-verifier",
						path: "src/example.ts",
						line: 12,
						detail: "## Unsafe input\n\n**User input** reaches the query.",
						recommendation: "Validate with `parseInput()` before querying.",
					},
				]}
			/>
		),
		{ width: 110, height: 55 },
	);
	let frame = t.captureCharFrame();
	for (
		let attempt = 0;
		attempt < 50 && !frame.includes("parseInput()");
		attempt++
	) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		frame = t.captureCharFrame();
	}
	expect(frame).toContain("security-verifier");
	expect(frame).toContain("Unsafe input");
	expect(frame).toContain("User input");
	expect(frame).not.toContain("**User input**");
	expect(frame).toContain("Recommended fix");
	expect(frame).toContain("parseInput()");
	expect(frame).not.toContain("`parseInput()`");
	t.renderer.destroy();
});
