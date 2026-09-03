import { expect, test } from "bun:test";
import {
	blockSelectionToLines,
	parseMarkdownBlocks,
} from "../../src/tui/dash/devenv-ui/markdownBlocks";

test("parses top-level blocks with exact source-line ranges", () => {
	const doc = `# Heading

A paragraph with **bold** text.

- item one
- item two
  - nested

> quoted line

\`\`\`ts
const x = 1;
const y = 2;
\`\`\`

| a | b |
|---|---|
| 1 | 2 |

---

1. first
2. second
`;
	const blocks = parseMarkdownBlocks(doc);
	expect(
		blocks.map((block) => [block.kind, block.startLine, block.endLine]),
	).toEqual([
		["heading", 1, 1],
		["paragraph", 3, 3],
		["list", 5, 7],
		["blockquote", 9, 9],
		["code", 11, 14],
		["table", 16, 18],
		["hr", 20, 20],
		["list", 22, 23],
	]);
});

test("keeps blank lines out of block ranges but preserves line numbers", () => {
	const doc = "one\n\n\n\n  - a\n  - b\n\n\nthree";
	const blocks = parseMarkdownBlocks(doc);
	expect(blocks).toEqual([
		{ kind: "paragraph", startLine: 1, endLine: 1, source: "one" },
		{ kind: "list", startLine: 5, endLine: 6, source: "  - a\n  - b" },
		{ kind: "paragraph", startLine: 9, endLine: 9, source: "three" },
	]);
});

test("handles CRLF line endings", () => {
	const doc = "# Title\r\n\r\nbody line\r\n\r\n- x\r\n- y\r\n";
	const blocks = parseMarkdownBlocks(doc);
	expect(
		blocks.map((block) => [block.kind, block.startLine, block.endLine]),
	).toEqual([
		["heading", 1, 1],
		["paragraph", 3, 3],
		["list", 5, 6],
	]);
});

test("handles empty and whitespace-only documents", () => {
	expect(parseMarkdownBlocks("")).toEqual([]);
	expect(parseMarkdownBlocks("\n\n\n")).toEqual([]);
});

test("documents without a trailing newline still map their last block", () => {
	const doc = "# Title\n\nLast paragraph";
	const blocks = parseMarkdownBlocks(doc);
	expect(
		blocks.map((block) => [block.kind, block.startLine, block.endLine]),
	).toEqual([
		["heading", 1, 1],
		["paragraph", 3, 3],
	]);
});

test("blockSelectionToLines maps a single block to its range", () => {
	const blocks = parseMarkdownBlocks("# a\n\n- one\n- two\n\nb");
	expect(blockSelectionToLines(blocks, 1, undefined)).toEqual({
		start: 3,
		end: 4,
	});
	expect(blockSelectionToLines(blocks, 0, undefined)).toEqual({
		start: 1,
		end: 1,
	});
});

test("blockSelectionToLines maps a visual range across blocks", () => {
	const blocks = parseMarkdownBlocks("# a\n\nb\n\nc");
	// Selection from block 0 to block 2 anchors line 1 through line 5.
	expect(blockSelectionToLines(blocks, 0, 2)).toEqual({ start: 1, end: 5 });
	// Reversed selection direction still anchors the outer range.
	expect(blockSelectionToLines(blocks, 2, 0)).toEqual({ start: 1, end: 5 });
});

test("blockSelectionToLines stays empty for empty documents", () => {
	expect(blockSelectionToLines([], 0, 2)).toEqual({});
});

test("blockSelectionToLines clamps out-of-range indices", () => {
	const blocks = parseMarkdownBlocks("# a\n\nb");
	expect(blockSelectionToLines(blocks, 99, undefined)).toEqual({
		start: 3,
		end: 3,
	});
});
