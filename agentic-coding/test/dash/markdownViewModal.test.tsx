/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
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
	const frame = await t.waitForFrame((value) => value.includes("item two"));
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
	expect(frame).toContain("6-7"); // the list block spans lines 6-7
	t.renderer.destroy();
});

test("selecting a block anchors comments to its source-line range", async () => {
	const range = { start: undefined as number | undefined, end: undefined as number | undefined };
	const t = await testRender(
		() => (
			<MarkdownViewModal
				filePath="proposal.md"
				content={ARTIFACT}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={3} // the list block (index 3) spans lines 6-7
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
	expect(range).toEqual({ start: 6, end: 7 });
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
	// Blocks: heading(1), paragraph(3), heading(5), list(6-7), quote(9),
	// code(11-13). A range from the first block to the list anchors 1..7.
	expect(captured).toEqual({ start: 1, end: 7 });
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
			new_line: 6, // inside the list block range (6-7)
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
	const frame = await t.waitForFrame((value) => value.includes("add a diagram"));
	expect(frame).toContain("add a diagram");
	expect(frame).toContain("Open");
	// The commented block (index 3) is reported for n/N cycling.
	expect(commentIndices).toEqual([3]);
	t.renderer.destroy();
});