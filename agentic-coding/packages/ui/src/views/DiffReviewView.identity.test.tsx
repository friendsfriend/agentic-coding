/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { type Renderable, TextRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
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
