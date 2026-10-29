/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import { parseColor, type TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { paintPromptCursor } from "../../src/tui/dash/ui/prompt-cursor.ts";

test("the prompt paints a steady cursor on every frame, preserving text and clearing on blur", async () => {
	const [focused, setFocused] = createSignal(true);
	let editor: TextareaRenderable | undefined;
	const t = await testRender(
		() => (
			<box
				width={12}
				height={3}
				renderAfter={(buffer) => {
					if (editor) paintPromptCursor.call(editor, buffer);
				}}
			>
				<textarea
					ref={(node) => {
						editor = node;
					}}
					width={12}
					height={3}
					focused={focused()}
					initialValue="a界é"
					showCursor={false}
					backgroundColor={uiColors.bgMantle}
				/>
			</box>
		),
		{ width: 12, height: 3 },
	);
	try {
		await t.renderOnce();
		if (!editor) throw new Error("Missing prompt editor");
		const cursorColor = Array.from(parseColor(uiColors.textPrimary).buffer);
		const cursorSpans = () =>
			t
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.filter((span) =>
					Array.from(span.bg.buffer).every(
						(value, index) => value === cursorColor[index],
					),
				);
		for (const [col, glyph] of [
			[0, "a"],
			[1, "界"],
			[3, "é"],
			[4, " "],
		] as const) {
			editor.editBuffer.setCursor(0, col);
			editor.requestRender();
			await t.renderOnce();
			expect(
				cursorSpans()
					.map((span) => span.text)
					.join(""),
			).toContain(glyph);
			expect(editor.showCursor).toBe(false);
			const before = t.captureSpans();
			await t.renderOnce();
			expect(t.captureSpans()).toEqual(before);
		}
		setFocused(false);
		await t.renderOnce();
		expect(cursorSpans()).toHaveLength(0);
	} finally {
		t.renderer.destroy();
	}
});
