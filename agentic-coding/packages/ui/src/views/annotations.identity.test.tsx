/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import {
	MarkdownRenderable,
	type Renderable,
	TextRenderable,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { DiscussionThread } from "./annotations.tsx";
import { DiffReviewView } from "./DiffReviewView.tsx";
import { MarkdownReviewView } from "./MarkdownReviewView.tsx";
import type { Discussion } from "./types.ts";

const note = (id: number, body: string): Discussion["notes"][number] => ({
	id,
	type: "DiffNote",
	body,
	author: { name: "Verifier One" },
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "",
	system: false,
	resolvable: true,
	resolved: false,
});

const discussion = (line: number): Discussion => ({
	id: "thread",
	individual_note: false,
	findingId: "finding",
	findingSeverity: "warning",
	notes: [note(1, "Original **finding**")],
	position: {
		base_sha: "",
		start_sha: "",
		head_sha: "",
		old_path: "review.md",
		new_path: "review.md",
		position_type: "text",
		new_line: line,
	},
});

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

test("an initially empty thread renders arriving notes and keeps message resources live through refreshes", async () => {
	const [current, setCurrent] = createSignal<Discussion>({
		...discussion(1),
		notes: [],
	});
	const [collapsed, setCollapsed] = createSignal(false);
	const t = await testRender(
		() => (
			<DiscussionThread
				discussion={current()}
				outdated={false}
				collapsed={collapsed()}
				formatTimestamp={() => "now"}
				paddingLeft={4}
			/>
		),
		{ width: 120, height: 35 },
	);
	try {
		await t.flush();
		expect(t.captureCharFrame()).not.toContain("FIX");
		setCurrent(discussion(1));
		await t.flush();
		const markdown = tree(t.renderer.root).find(
			(node) => node instanceof MarkdownRenderable,
		);
		const author = tree(t.renderer.root).find(
			(node) =>
				node instanceof TextRenderable && node.plainText === "Verifier One",
		);
		if (
			!(markdown instanceof MarkdownRenderable) ||
			!(author instanceof TextRenderable)
		)
			throw new Error("Missing arriving note");
		setCurrent((value) => ({
			...value,
			notes: [
				...value.notes.map((note) => ({
					...note,
					resolved: true,
					body: "Updated **finding**",
					author: { name: "Updated verifier" },
				})),
				note(2, "Reply"),
			],
		}));
		await t.renderOnce();
		expect(markdown.isDestroyed).toBe(false);
		expect(author.isDestroyed).toBe(false);
		expect(markdown.content).toBe("Updated **finding**");
		expect(author.plainText).toBe("Updated verifier");
		expect(t.captureCharFrame()).toContain("☑ FIX");
		setCollapsed(true);
		await t.flush();
		expect(t.captureCharFrame()).toContain("Show 2 messages");
		setCurrent((value) => ({
			...value,
			notes: [...value.notes, note(3, "Another reply")],
		}));
		await t.flush();
		expect(t.captureCharFrame()).toContain("Show 3 messages");
	} finally {
		t.renderer.destroy();
	}
});

for (const mode of [
	"markdown",
	"diff",
	"split",
	"markdown-diff",
	"markdown-split",
] as const) {
	test(`${mode} review retains discussion and note renderers across refreshed thread objects`, async () => {
		const [threads, setThreads] = createSignal([
			discussion(mode === "markdown" ? 3 : 2),
		]);
		const common = {
			filePath: "review.md",
			currentFileIndex: 0,
			totalFiles: 1,
			selectedLine: 0,
			visualModeActive: false,
			visualModeStart: 0,
			commentMode: false,
			commentText: "",
			onSelectedLineChange: () => {},
			onClose: () => {},
		};
		const t = await testRender(
			() =>
				mode === "markdown" ? (
					<MarkdownReviewView
						{...common}
						page
						content={"# Heading\n\nBody\n"}
						discussions={threads()}
					/>
				) : (
					<DiffReviewView
						{...common}
						diff={"@@ -1,3 +1,3 @@\n header\n body\n footer"}
						forceSplitView={mode === "split" || mode === "markdown-split"}
						renderMarkdown={
							mode === "markdown-diff" || mode === "markdown-split"
						}
						discussions={threads()}
					/>
				),
			{ width: 140, height: 40 },
		);
		try {
			await t.flush();
			const markdown = tree(t.renderer.root).find(
				(node) =>
					node instanceof MarkdownRenderable &&
					node.content.includes("Original **finding**"),
			);
			if (!(markdown instanceof MarkdownRenderable))
				throw new Error("Missing review finding note");
			setThreads((current) =>
				current.map((thread) => ({
					...thread,
					notes: thread.notes.map((note) => ({
						...note,
						body: "Changed **finding**",
						resolved: true,
					})),
				})),
			);
			await t.renderOnce();
			expect(markdown.isDestroyed).toBe(false);
			expect(markdown.content).toBe("Changed **finding**");
			expect(t.captureCharFrame()).toContain("☑ FIX");
		} finally {
			t.renderer.destroy();
		}
	});
}
