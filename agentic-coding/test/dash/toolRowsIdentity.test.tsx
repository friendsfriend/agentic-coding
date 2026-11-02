/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import {
	CodeRenderable,
	MarkdownRenderable,
	type Renderable,
	TextRenderable,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { AgentSessionBlock } from "../../src/tui/dash/agent-session.ts";
import { ToolRows } from "../../src/tui/dash/ui/AgentSessionView.tsx";
import { SessionMarkdownCache } from "../../src/tui/dash/ui/session-markdown-cache.ts";
import { ToolTable } from "../../src/tui/dash/ui/ToolTable.tsx";
import type { ToolViewRow } from "../../src/tui/dash/ui/tool-views.ts";

const block: AgentSessionBlock = {
	id: "nested-tool",
	kind: "tool",
	tone: "base",
	text: "tool",
};
function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

test("nested tool rows retain native renderers across refreshed payloads and keyed reordering", async () => {
	const [rows, setRows] = createSignal<readonly ToolViewRow[]>([
		{ id: "source", text: "const stable = 1;", syntax: "typescript" },
		{ id: "context", text: "Retained context.", markdown: true },
	]);
	const cache = new SessionMarkdownCache();
	const t = await testRender(
		() => (
			<ToolRows
				rows={rows()}
				block={block}
				openRows={() => new Set<string>()}
				onToggleRow={() => {}}
				transcript={(key, text) => cache.parts(key, text)}
			/>
		),
		{ width: 80, height: 20 },
	);
	try {
		await t.renderOnce();
		const code = tree(t.renderer.root).find(
			(node) => node instanceof CodeRenderable,
		);
		const markdown = tree(t.renderer.root).find(
			(node) => node instanceof MarkdownRenderable,
		);
		if (
			!(code instanceof CodeRenderable) ||
			!(markdown instanceof MarkdownRenderable)
		)
			throw new Error("Missing nested native renderers");
		setRows((current) =>
			[...current].reverse().map((row) => ({
				...row,
				...(row.id === "source" ? { text: "const stable = 2;" } : {}),
			})),
		);
		await t.renderOnce();
		expect(code.isDestroyed).toBe(false);
		expect(markdown.isDestroyed).toBe(false);
		expect(code.content).toBe("const stable = 2;");
		setRows((current) =>
			current.map((row) =>
				row.id === "source"
					? { id: row.id, text: "Changed to plain text" }
					: row,
			),
		);
		await t.renderOnce();
		expect(code.isDestroyed).toBe(true);
		expect(markdown.isDestroyed).toBe(false);
		expect(t.captureCharFrame()).toContain("Changed to plain text");
	} finally {
		t.renderer.destroy();
	}
});

test("growing past the chunking threshold does not remount completed source rows", async () => {
	const [rows, setRows] = createSignal<readonly ToolViewRow[]>([
		{ id: "source", text: "const stable = 1;", syntax: "typescript" },
		...Array.from({ length: 79 }, (_, index) => ({
			id: `row-${index}`,
			text: `row ${index}`,
		})),
	]);
	const cache = new SessionMarkdownCache();
	const t = await testRender(
		() => (
			<ToolRows
				rows={rows()}
				block={block}
				openRows={() => new Set<string>()}
				onToggleRow={() => {}}
				transcript={(key, text) => cache.parts(key, text)}
			/>
		),
		{ width: 80, height: 20 },
	);
	try {
		await t.renderOnce();
		const code = tree(t.renderer.root).find(
			(node) => node instanceof CodeRenderable,
		);
		if (!(code instanceof CodeRenderable))
			throw new Error("Missing source row");
		setRows((current) => [
			...current.map((row) => ({ ...row })),
			{ id: "last", text: "new output" },
		]);
		await t.renderOnce();
		expect(code.isDestroyed).toBe(false);
		expect(
			tree(t.renderer.root).find((node) => node instanceof CodeRenderable),
		).toBe(code);
	} finally {
		t.renderer.destroy();
	}
});

test("a retained row becomes foldable when detail arrives and keeps its fold after its label changes", async () => {
	const [rows, setRows] = createSignal<readonly ToolViewRow[]>([
		{ id: "option", text: "Choice" },
	]);
	const [folded, setFolded] = createSignal<ReadonlySet<string>>(new Set());
	const cache = new SessionMarkdownCache();
	const t = await testRender(
		() => (
			<ToolRows
				rows={rows()}
				block={block}
				openRows={folded}
				onToggleRow={(key) =>
					setFolded((current) =>
						current.has(key) ? new Set() : new Set([key]),
					)
				}
				transcript={(key, text) => cache.parts(key, text)}
			/>
		),
		{ width: 80, height: 20 },
	);
	try {
		await t.renderOnce();
		setRows([
			{
				id: "option",
				text: "Choice",
				detail: [{ id: "why", text: "New rationale" }],
			},
		]);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("New rationale");
		await t.mockMouse.click(2, 0);
		await t.renderOnce();
		expect(folded().has("nested-tool:option")).toBe(true);
		expect(t.captureCharFrame()).not.toContain("New rationale");
		setRows([
			{
				id: "option",
				text: "Updated choice",
				detail: [{ id: "why", text: "Updated rationale" }],
			},
		]);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Updated choice");
		expect(t.captureCharFrame()).not.toContain("Updated rationale");
		await t.mockMouse.click(2, 0);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Updated rationale");
	} finally {
		t.renderer.destroy();
	}
});

test("table payload refreshes update retained cells without replacing native text nodes", async () => {
	const [table, setTable] = createSignal({
		columns: ["status", "name"],
		rows: [["running", "Before"]],
	});
	const t = await testRender(() => <ToolTable table={table()} />, {
		width: 80,
		height: 10,
	});
	try {
		await t.renderOnce();
		await t.renderOnce();
		const cell = tree(t.renderer.root).find(
			(node) => node instanceof TextRenderable && node.plainText === "Before",
		);
		if (!(cell instanceof TextRenderable))
			throw new Error("Missing table cell");
		setTable({ columns: ["status", "name"], rows: [["completed", "After"]] });
		await t.renderOnce();
		expect(cell.isDestroyed).toBe(false);
		expect(cell.plainText).toBe("After");
		expect(t.captureCharFrame()).toContain("completed");
	} finally {
		t.renderer.destroy();
	}
});
