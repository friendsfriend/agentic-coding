/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { MarkdownViewModal } from "../../src/tui/dash/devenv-ui/components/MarkdownViewModal";
import type { Discussion } from "../../src/tui/dash/devenv-ui/types";

const ARTIFACT = `# Proposal

Make the plan review modal-based.

## What changes

- item one
- item two

> review note

\`\`\`ts
const value = 1;
\`\`\`
`;

/**
 * OpenTUI's markdown block renderer highlights text asynchronously via a
 * background tree-sitter worker; `t.waitForFrame` resolves once OpenTUI's
 * render loop goes idle, which doesn't yield real time for that worker to
 * reply. Poll with a real `setTimeout` between renders so the worker gets a
 * chance to finish (matches real terminal usage, where the first paint is
 * unstyled until the worker warms up).
 */
async function waitForRealFrame(
	t: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean,
	timeoutMs = 5000,
): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await t.renderOnce();
		const frame = t.captureCharFrame();
		if (predicate(frame)) return frame;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Timed out waiting for frame predicate");
}

test("markdown modal renders whole-document blocks without source delimiters", async () => {
	const t = await testRender(
		() => (
			<MarkdownViewModal
				filePath="proposal.md"
				content={ARTIFACT}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={0}
				visualModeActive={false}
				visualModeStart={0}
				commentMode={false}
				commentText=""
				onSelectedLineChange={() => {}}
				onSelectedSourceRangeChange={() => {}}
				onClose={() => {}}
			/>
		),
		{ width: 120, height: 40 },
	);
	const frame = await waitForRealFrame(t, (value) =>
		value.includes("item two"),
	);
	// Block-level rendering: headings, paragraphs, list items, block quote,
	// and fenced code all show their formatted content.
	expect(frame).toContain("Proposal");
	expect(frame).not.toContain("# Proposal");
	expect(frame).toContain("What changes");
	expect(frame).not.toContain("## What changes");
	expect(frame).toContain("item one");
	expect(frame).toContain("item two");
	expect(frame).toContain("review note");
	expect(frame).toContain("const value = 1;");
	// Source-line ranges are visible in the gutter, including multi-line blocks.
	expect(frame).toContain("7-8"); // the list block spans lines 7-8
	t.renderer.destroy();
});

test("selecting a block anchors comments to its source-line range", async () => {
	const range = {
		start: undefined as number | undefined,
		end: undefined as number | undefined,
	};
	const t = await testRender(
		() => (
			<MarkdownViewModal
				filePath="proposal.md"
				content={ARTIFACT}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={3} // the list block (index 3) spans lines 7-8
				visualModeActive={false}
				visualModeStart={0}
				commentMode={false}
				commentText=""
				onSelectedLineChange={() => {}}
				onSelectedSourceRangeChange={(start, end) => {
					range.start = start;
					range.end = end;
				}}
				onClose={() => {}}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.renderOnce();
	expect(range).toEqual({ start: 7, end: 8 });
	t.renderer.destroy();
});

test("visual range maps to the outer block source-line range", async () => {
	let captured: { start?: number; end?: number } = {};
	const t = await testRender(
		() => (
			<MarkdownViewModal
				filePath="proposal.md"
				content={ARTIFACT}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={3}
				visualModeActive
				visualModeStart={0}
				commentMode={false}
				commentText=""
				onSelectedLineChange={() => {}}
				onSelectedSourceRangeChange={(start, end) => {
					captured = { start, end };
				}}
				onClose={() => {}}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.renderOnce();
	// Blocks: heading(1), paragraph(3), heading(5), list(7-8), quote(10),
	// code(12-14). A range from the first block to the list anchors 1..8.
	expect(captured).toEqual({ start: 1, end: 8 });
	t.renderer.destroy();
});

test("comment threads render inline under their block and cycle indices include it", async () => {
	let commentIndices: number[] = [];
	const discussion: Discussion = {
		id: "wiki-1",
		individual_note: true,
		position: {
			base_sha: "",
			start_sha: "",
			head_sha: "",
			old_path: "proposal.md",
			new_path: "proposal.md",
			position_type: "text",
			new_line: 7, // inside the list block range (7-8)
		},
		notes: [
			{
				id: 1,
				type: "DiffNote",
				body: "add a diagram",
				author: { name: "Developer" },
				created_at: new Date(0).toISOString(),
				updated_at: "",
				system: false,
				resolvable: false,
				resolved: false,
			},
		],
	};
	const t = await testRender(
		() => (
			<MarkdownViewModal
				filePath="proposal.md"
				content={ARTIFACT}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={3}
				visualModeActive={false}
				visualModeStart={0}
				commentMode={false}
				commentText=""
				discussions={[discussion]}
				onSelectedLineChange={() => {}}
				onSelectedSourceRangeChange={() => {}}
				onDiscussionLineIndicesChange={(indices) => {
					commentIndices = indices;
				}}
				onClose={() => {}}
			/>
		),
		{ width: 120, height: 40 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("add a diagram"),
	);
	expect(frame).toContain("add a diagram");
	expect(frame).toContain("Open");
	// The commented block (index 3) is reported for n/N cycling.
	expect(commentIndices).toEqual([3]);
	t.renderer.destroy();
});
