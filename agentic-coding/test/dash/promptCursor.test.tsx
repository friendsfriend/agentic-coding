/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import { parseColor, type Renderable, TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { AgentSessionView } from "../../src/tui/dash/ui/AgentSessionView.tsx";

function findEditor(node: Renderable): TextareaRenderable | undefined {
	if (node instanceof TextareaRenderable) return node;
	for (const child of node.getChildren()) {
		const found = findEditor(child);
		if (found) return found;
	}
	return undefined;
}

test("the actual transcript input retains OpenCode-style native block cursor settings through redraw and focus changes", async () => {
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
		for (const busy of [true, false, true]) {
			setWorking(busy);
			await t.renderOnce();
			expect(findEditor(t.renderer.root)).toBe(editor);
			expect(editor.focused).toBe(true);
			expect(editor.showCursor).toBe(true);
			expect(editor.cursorStyle).toMatchObject({
				style: "block",
				blinking: false,
			});
			expect(Array.from(editor.cursorColor.buffer)).toEqual(
				Array.from(parseColor(uiColors.textPrimary).buffer),
			);
		}
		setActive(false);
		await t.renderOnce();
		expect(editor.focused).toBe(false);
		setActive(true);
		await t.renderOnce();
		expect(editor.focused).toBe(true);
		expect(editor.showCursor).toBe(true);
		expect(editor.cursorStyle).toMatchObject({
			style: "block",
			blinking: false,
		});
	} finally {
		t.renderer.destroy();
	}
});
