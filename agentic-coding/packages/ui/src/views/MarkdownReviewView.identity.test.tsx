/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import {
	MarkdownRenderable,
	type Renderable,
	type ScrollBoxRenderable,
	TextRenderable,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { MarkdownReviewView } from "./MarkdownReviewView.tsx";
import type { Discussion } from "./types.ts";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

test("unchanged review blocks retain Markdown while source ranges and click indices follow inserted content", async () => {
	const [content, setContent] = createSignal(
		"# Heading\n\nRetained paragraph.\n\nMutable paragraph one.\n",
	);
	const [selected, setSelected] = createSignal(0);
	const ranges: (number | undefined)[][] = [];
	const t = await testRender(
		() => (
			<MarkdownReviewView
				page
				filePath="docs/review.md"
				content={content()}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={selected()}
				visualModeActive={false}
				visualModeStart={0}
				commentMode={false}
				commentText=""
				onSelectedLineChange={setSelected}
				onSelectedSourceRangeChange={(start, end) => ranges.push([start, end])}
				onClose={() => {}}
			/>
		),
		{ width: 120, height: 24 },
	);
	try {
		await t.flush();
		const retained = tree(t.renderer.root).find(
			(node) =>
				node instanceof MarkdownRenderable &&
				node.content.includes("Retained paragraph"),
		);
		const changed = tree(t.renderer.root).find(
			(node) =>
				node instanceof MarkdownRenderable &&
				node.content.includes("Mutable paragraph one"),
		);
		if (
			!(retained instanceof MarkdownRenderable) ||
			!changed ||
			!retained.parent
		)
			throw new Error("Missing review blocks");
		const label = retained.parent
			.getChildren()
			.find((node) => node instanceof TextRenderable && node.plainText === "3");
		if (!(label instanceof TextRenderable))
			throw new Error("Missing source gutter");
		setContent(
			"# Heading\n\nInserted paragraph.\n\nRetained paragraph.\n\nMutable paragraph two.\n",
		);
		await t.renderOnce();
		await t.renderOnce();
		expect(retained.isDestroyed).toBe(false);
		expect(changed.isDestroyed).toBe(true);
		expect(label.isDestroyed).toBe(false);
		expect(label.plainText).toBe("5");
		await t.mockMouse.click(15, retained.screenY);
		await t.flush();
		expect(selected()).toBe(2);
		expect(ranges.at(-1)).toEqual([5, 5]);
	} finally {
		t.renderer.destroy();
	}
});

test("annotation refreshes do not scroll a reader back to the selected review block", async () => {
	const body = Array.from(
		{ length: 50 },
		(_, index) => `Paragraph ${index}.`,
	).join("\n\n");
	const [file, setFile] = createSignal({
		path: "docs/review.md",
		content: body,
	});
	const [selected, setSelected] = createSignal(0);
	const [discussions, setDiscussions] = createSignal<Discussion[]>([
		{
			id: "thread",
			individual_note: false,
			notes: [],
			position: {
				base_sha: "base",
				start_sha: "start",
				head_sha: "head",
				old_path: "docs/review.md",
				new_path: "docs/review.md",
				position_type: "text",
				new_line: 1,
			},
		},
	]);
	let scroll: ScrollBoxRenderable | undefined;
	const t = await testRender(
		() => (
			<MarkdownReviewView
				page
				filePath={file().path}
				content={file().content}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={selected()}
				visualModeActive={false}
				visualModeStart={0}
				commentMode={false}
				commentText=""
				discussions={discussions()}
				onSelectedLineChange={setSelected}
				onScrollBoxReady={(box) => {
					scroll = box;
				}}
				onClose={() => {}}
			/>
		),
		{ width: 120, height: 24 },
	);
	try {
		await t.flush();
		if (!scroll) throw new Error("Missing review scrollbox");
		scroll.scrollTop = 5;
		await t.flush();
		expect(scroll.scrollTop).toBe(5);
		setDiscussions((current) =>
			current.map((discussion) => ({
				...discussion,
				position: discussion.position ? { ...discussion.position } : undefined,
			})),
		);
		await t.flush();
		expect(scroll.scrollTop).toBe(5);
		setFile((current) => ({ ...current }));
		await t.flush();
		expect(scroll.scrollTop).toBe(5);
		setSelected(1);
		await t.flush();
		expect(scroll.scrollTop).toBeLessThan(5);
	} finally {
		t.renderer.destroy();
	}
});
