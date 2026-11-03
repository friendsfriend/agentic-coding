/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import {
	BoxRenderable,
	MarkdownRenderable,
	parseColor,
	type Renderable,
	TextRenderable,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { uiColors } from "../theme/colors.ts";
import { DiffReviewView } from "./DiffReviewView.tsx";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

const diff = (added: string) =>
	[
		"--- a/file.ts",
		"+++ b/file.ts",
		"@@ -1,3 +1,3 @@",
		" retained_line();",
		"-old_line();",
		`+${added}`,
		" tail_line();",
	].join("\n");

const paragraphDiff = (second: string, added = true) =>
	[
		"--- a/review.md",
		"+++ b/review.md",
		"@@ -1,6 +1,6 @@",
		" # Stable heading",
		" ",
		" First paragraph line.",
		...(added ? ["-Old second line.", `+${second}`] : [` ${second}`]),
		" ",
		" Stable footer.",
	].join("\n");

for (const split of [false, true]) {
	test(`${split ? "split" : "unified"} Markdown diff refreshes multiline blocks without rebuilding unchanged siblings or freezing tint`, async () => {
		const [content, setContent] = createSignal(
			paragraphDiff("Initial second line."),
		);
		const [selected, setSelected] = createSignal(0);
		const ranges: (number | undefined)[][] = [];
		const t = await testRender(
			() => (
				<DiffReviewView
					filePath="review.md"
					diff={content()}
					renderMarkdown
					forceSplitView={split}
					currentFileIndex={0}
					totalFiles={1}
					selectedLine={selected()}
					onSelectedLineChange={setSelected}
					visualModeActive={false}
					visualModeStart={0}
					commentMode={false}
					commentText=""
					onSelectedSourceRangeChange={(start, end) =>
						ranges.push([start, end])
					}
					onClose={() => {}}
				/>
			),
			{ width: 140, height: 35 },
		);
		const markdowns = () =>
			tree(t.renderer.root).filter(
				(node): node is MarkdownRenderable =>
					node instanceof MarkdownRenderable,
			);
		try {
			await t.flush();
			const unchanged = markdowns().filter(
				(node) =>
					node.content.includes("Stable heading") ||
					node.content.includes("Stable footer"),
			);
			const paragraph = markdowns().find((node) =>
				node.content.includes("Initial second line."),
			);
			if (!paragraph || unchanged.length === 0)
				throw new Error("Missing initial Markdown diff blocks");
			setContent(paragraphDiff("Updated second line."));
			await t.renderOnce();
			for (const node of unchanged) expect(node.isDestroyed).toBe(false);
			const updated = markdowns().find((node) =>
				node.content.includes("Updated second line."),
			);
			if (!updated) throw new Error("Multiline Markdown block did not update");
			if (!split) expect(updated).toBe(paragraph);
			await t.mockMouse.click(updated.screenX + 2, updated.screenY);
			await t.flush();
			expect(selected()).toBe(1);
			expect(ranges.at(-1)).toEqual([3, 4]);
			setContent(paragraphDiff("Updated second line.", false));
			await t.renderOnce();
			const context = markdowns().find((node) =>
				node.content.includes("Updated second line."),
			);
			if (!context || !(context.parent instanceof BoxRenderable))
				throw new Error("Missing context Markdown block");
			expect(context.parent.backgroundColor).toEqual(
				parseColor(uiColors.diffContextBg),
			);
			expect(context.content).toContain("First paragraph line.");
			// The second context row was previously inside a block, so its row
			// component rendered nothing. When a preceding line becomes blank it
			// must reactively become the new block anchor, not stay empty forever.
			setContent(
				paragraphDiff("Updated second line.", false).replace(
					" First paragraph line.",
					" ",
				),
			);
			await t.renderOnce();
			const reanchored = markdowns().find((node) =>
				node.content.includes("Updated second line."),
			);
			if (!reanchored)
				throw new Error("New Markdown block anchor stayed empty");
			expect(reanchored.content).not.toContain("First paragraph line.");
			expect(ranges.at(-1)).toEqual([4, 4]);
		} finally {
			t.renderer.destroy();
		}
	});
}

for (const split of [false, true]) {
	test(`${split ? "split" : "unified"} diff retains unchanged line renderers when a sibling changes and resets on another file`, async () => {
		const [content, setContent] = createSignal(diff("new_one();"));
		const [file, setFile] = createSignal("file.ts");
		const [selected, setSelected] = createSignal(1);
		const ranges: (number | undefined)[][] = [];
		const t = await testRender(
			() => (
				<DiffReviewView
					filePath={file()}
					diff={content()}
					currentFileIndex={0}
					totalFiles={1}
					selectedLine={selected()}
					onSelectedLineChange={setSelected}
					visualModeActive={false}
					visualModeStart={0}
					commentMode={false}
					commentText=""
					forceSplitView={split}
					onSelectedSourceRangeChange={(start, end) =>
						ranges.push([start, end])
					}
					onClose={() => {}}
				/>
			),
			{ width: 140, height: 30 },
		);
		try {
			await t.flush();
			const retained = tree(t.renderer.root).find(
				(node) =>
					node instanceof TextRenderable &&
					node.plainText.includes("retained_line();"),
			);
			const changed = tree(t.renderer.root).find(
				(node) =>
					node instanceof TextRenderable &&
					node.plainText.includes("new_one();"),
			);
			if (!(retained instanceof TextRenderable) || !changed)
				throw new Error("Missing diff line renderers");
			setContent(diff("new_two();"));
			await t.renderOnce();
			expect(retained.isDestroyed).toBe(false);
			expect(changed.isDestroyed).toBe(true);
			expect(t.captureCharFrame()).toContain("new_two();");
			await t.mockMouse.click(retained.screenX + 2, retained.screenY);
			await t.flush();
			expect(selected()).toBe(0);
			expect(ranges.at(-1)).toEqual([1, 1]);
			setFile("another-file.ts");
			await t.flush();
			expect(retained.isDestroyed).toBe(true);
		} finally {
			t.renderer.destroy();
		}
	});
}
