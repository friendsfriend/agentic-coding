/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import { parseColor, type Renderable, TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { AgentSessionView } from "../../src/tui/dash/ui/AgentSessionView.tsx";
import {
	createPromptCursorBlink,
	PROMPT_CURSOR_BLINK_MS,
} from "../../src/tui/dash/ui/prompt-cursor.ts";

test("cursor blink follows elapsed time regardless of redraw frequency", () => {
	let time = 0;
	const blink = createPromptCursorBlink(() => time);
	for (let frame = 0; frame < 1000; frame++) expect(blink.visible()).toBe(true);
	time = PROMPT_CURSOR_BLINK_MS;
	for (let frame = 0; frame < 1000; frame++)
		expect(blink.visible()).toBe(false);
	time = PROMPT_CURSOR_BLINK_MS * 2;
	expect(blink.visible()).toBe(true);
	time = PROMPT_CURSOR_BLINK_MS * 3 + 50;
	expect(blink.visible()).toBe(false);
	blink.reset();
	expect(blink.visible()).toBe(true);
	time += PROMPT_CURSOR_BLINK_MS - 1;
	expect(blink.visible()).toBe(true);
	time++;
	expect(blink.visible()).toBe(false);
});

function findEditor(node: Renderable): TextareaRenderable | undefined {
	if (node instanceof TextareaRenderable) return node;
	for (const child of node.getChildren()) {
		const found = findEditor(child);
		if (found) return found;
	}
	return undefined;
}

test("the actual transcript paints a visible block on consecutive frames without toggling the hardware cursor", async () => {
	const [active, setActive] = createSignal(true);
	const [working, setWorking] = createSignal(false);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[]}
				working={working()}
				inputActive={active}
				models={[]}
				thinkingLevels={[]}
				draft="a界é"
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 20 },
	);
	try {
		await new Promise((resolve) => setTimeout(resolve, 10));
		await t.renderOnce();
		const editor = findEditor(t.renderer.root);
		if (!editor) throw new Error("Missing transcript prompt");
		const color = Array.from(parseColor(uiColors.textPrimary).buffer);
		const cursorSpans = () =>
			t
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.filter((span) =>
					Array.from(span.bg.buffer).every(
						(value, index) => value === color[index],
					),
				);
		for (const busy of [true, false, true]) {
			setWorking(busy);
			await t.renderOnce();
			expect(findEditor(t.renderer.root)).toBe(editor);
			expect(editor.focused).toBe(true);
			expect(editor.showCursor).toBe(false);
			expect(t.renderer.getCursorState().visible).toBe(false);
			expect(cursorSpans().length).toBeGreaterThan(0);
			const before = cursorSpans();
			await t.renderOnce();
			expect(cursorSpans()).toEqual(before);
		}
		editor.editBuffer.setCursor(0, 1);
		editor.requestRender();
		await t.renderOnce();
		expect(
			cursorSpans()
				.map((span) => span.text)
				.join(""),
		).toBe("界");
		editor.editBuffer.setCursor(0, 3);
		editor.requestRender();
		await t.renderOnce();
		expect(
			cursorSpans()
				.map((span) => span.text)
				.join(""),
		).toBe("é");
		// A long multiline draft scrolls inside the editor. Its visual cursor
		// already accounts for that viewport; subtracting scrollY hides it.
		editor.setText(
			Array.from({ length: 14 }, (_, index) => `draft line ${index}`).join(
				"\n",
			),
		);
		editor.gotoBufferEnd();
		await t.renderOnce();
		await t.renderOnce();
		expect(editor.scrollY).toBeGreaterThan(0);
		expect(cursorSpans().length).toBeGreaterThan(0);
		expect(t.renderer.getCursorState().visible).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 650));
		await t.renderOnce();
		expect(cursorSpans()).toHaveLength(0);
		await t.renderOnce();
		expect(cursorSpans()).toHaveLength(0);
		// Editing restores the block immediately, without waiting for a phase.
		editor.insertText("x");
		await t.renderOnce();
		expect(cursorSpans().length).toBeGreaterThan(0);
		setActive(false);
		await t.renderOnce();
		expect(editor.focused).toBe(false);
		expect(cursorSpans()).toHaveLength(0);
		setActive(true);
		await t.renderOnce();
		expect(editor.focused).toBe(true);
		expect(editor.showCursor).toBe(false);
		expect(cursorSpans().length).toBeGreaterThan(0);
	} finally {
		t.renderer.destroy();
	}
});
