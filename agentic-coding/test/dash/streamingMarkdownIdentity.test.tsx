/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { MarkdownRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { AgentSessionView } from "../../src/tui/dash/ui/AgentSessionView.tsx";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

for (const fenced of [false, true]) {
	test(`streamed ${fenced ? "code" : "prose"} keeps its Markdown renderer through growth, settling and completion`, async () => {
		const heading = "# Stable heading\n\n";
		const initial =
			heading +
			(fenced
				? "```ts\nconst first = 1;\nconst second"
				: "First line.\nGrowing");
		const [text, setText] = createSignal(initial);
		const [live, setLive] = createSignal(true);
		const t = await testRender(
			() => (
				<AgentSessionView
					role="worker"
					blocks={[
						{
							id: "live-answer",
							kind: "assistant",
							text: text(),
							tone: "base",
							live: live(),
						},
					]}
					working={live()}
					models={[]}
					thinkingLevels={[]}
					draft=""
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
			{ width: 100, height: 30 },
		);
		const markdowns = () =>
			tree(t.renderer.root).filter(
				(node): node is MarkdownRenderable =>
					node instanceof MarkdownRenderable,
			);
		try {
			await t.renderOnce();
			await t.renderOnce();
			const settled = markdowns()[0];
			const growing = markdowns()[1];
			if (!settled || !growing)
				throw new Error("Missing initial Markdown parts");
			for (const suffix of [" more", " more text"]) {
				setText(initial + suffix);
				await t.renderOnce();
				expect(settled.isDestroyed).toBe(false);
				expect(growing.isDestroyed).toBe(false);
				expect(markdowns()[1]).toBe(growing);
			}
			setText(
				heading +
					(fenced
						? "```ts\nconst first = 1;\nconst second = 2;\nconst third = 3;\nconst tail"
						: "First line.\nGrowing complete.\nAnother complete line.\nNext tail"),
			);
			await t.renderOnce();
			expect(growing.isDestroyed).toBe(false);
			expect(growing.content).toContain(
				fenced ? "const second = 2;" : "Growing complete.",
			);
			setText(
				heading +
					(fenced
						? "```ts\nconst first = 1;\nconst second = 2;\nconst third = 3;\n```\n\nAdditional block."
						: "First line.\nGrowing complete.\nNext tail.\n\nAdditional block."),
			);
			await t.renderOnce();
			expect(settled.isDestroyed).toBe(false);
			expect(growing.isDestroyed).toBe(false);
			expect(markdowns().length).toBe(3);
			const last = markdowns()[2];
			setLive(false);
			await t.renderOnce();
			expect(markdowns()).toEqual([settled, growing, last]);
			expect(last?.content).toContain("Additional block.");
			// A real code/prose transition must still replace that part, not leave
			// a retained renderer configured for its previous presentation shape.
			setText(
				heading +
					(fenced ? "Changed to prose." : "```ts\nconst changed = true;\n```"),
			);
			await t.renderOnce();
			expect(settled.isDestroyed).toBe(false);
			expect(growing.isDestroyed).toBe(true);
		} finally {
			t.renderer.destroy();
		}
	});
}
