import { expect, test } from "bun:test";
import {
	blockSelectionToLines,
	type MarkdownBlockPart,
	markdownBlockParts,
	parseMarkdownBlocks,
	streamingMarkdownBlockParts,
	streamingTailSource,
} from "@agentic-coding/ui";

/** The one part a document here renders as; every document below has one. */
function onlyPart(content: string): MarkdownBlockPart {
	const part = markdownBlockParts(content)[0];
	if (!part) throw new Error(`no part for ${JSON.stringify(content)}`);
	return part;
}

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

test("splits a document into the parts a transcript renders", () => {
	const parts = markdownBlockParts(
		"# Plan\n\nStep one.\n\n```ts\nconst x = 1;\n```\n",
	);
	// Fenced code is drawn as its own text instead of through the syntax pass.
	expect(parts.map((part) => part.code)).toEqual([false, false, true]);
	expect(parts[0]?.source).toBe("# Plan\n");
	expect(parts[2]?.source).toContain("const x = 1;");
});

test("a streamed message reuses the parts its earlier frames settled", () => {
	const first = "# Plan\n\nStep one.\n";
	const grown = `${first}\nStep two with **bold**.\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`;
	const start = streamingMarkdownBlockParts(undefined, first);
	const next = streamingMarkdownBlockParts(start, grown);
	// The settled part is the same object, which is what keeps its render row.
	expect(next.parts[0]).toBe(start.parts[0]);
	// And the reuse is invisible: the result is what a full parse produces.
	expect(next.parts).toEqual(markdownBlockParts(grown));
	// The tail moved to the last part, so the next frame lexes from there.
	expect(grown.slice(next.tail)).toContain("const x = 1;");
});

test("a text that is not an extension of the cached one is parsed in full", () => {
	const start = streamingMarkdownBlockParts(undefined, "# one\n\nbody\n");
	// A different message under the same key: nothing is reused, so parts can
	// never be spliced from another document.
	const replaced = streamingMarkdownBlockParts(start, "# two\n\nother body\n");
	expect(replaced.parts).toEqual(markdownBlockParts("# two\n\nother body\n"));
	expect(replaced.parts[0]).not.toBe(start.parts[0]);
	// A message that only shrank re-parses too.
	expect(streamingMarkdownBlockParts(start, "# one\n").parts).toEqual(
		markdownBlockParts("# one\n"),
	);
});

test("an empty document has no parts and no tail", () => {
	const empty = streamingMarkdownBlockParts(undefined, "");
	expect(empty.parts).toEqual([]);
	expect(empty.tail).toBe(0);
	// The first text that arrives is parsed from the start.
	expect(streamingMarkdownBlockParts(empty, "hello").parts).toEqual(
		markdownBlockParts("hello"),
	);
});

test("holds back an unfinished trailing line of a streamed part", () => {
	// A document-ending newline and the trailing space of a bare list marker are
	// what the next character takes back; drawing them costs a row for a frame.
	expect(streamingTailSource(onlyPart("body\n"))).toBe("body");
	const list = onlyPart("- one\n- ");
	expect(list.code).toBe(false);
	expect(streamingTailSource(list)).toBe("- one\n-");
	// Trailing blank lines go too: the next frame's block starts there.
	expect(streamingTailSource(onlyPart("body\n\n"))).toBe("body");
});

test("holds back a partly typed closing code fence", () => {
	const open = onlyPart("```ts\nconst x = 1;\n``");
	expect(open.code).toBe(true);
	expect(streamingTailSource(open)).toBe("```ts\nconst x = 1;");
	// A block's own opening fence is not a marker being closed, so a block that
	// has only just opened keeps its row.
	const opening = onlyPart("```");
	expect(opening.code).toBe(true);
	expect(streamingTailSource(opening)).toBe("```");
	// In prose a line of backticks is text the model wrote: only a fenced block
	// swallows a trailing marker line as its own content.
	const prose = onlyPart("body\n``");
	expect(prose.code).toBe(false);
	expect(streamingTailSource(prose)).toBe("body\n``");
});

test("leaves a settled part untouched", () => {
	const parts = markdownBlockParts("body\n\n- one\n- two\n");
	// The blank line after the paragraph is the spacing to the next block, so
	// it stays on a part that is no longer growing.
	expect(parts[0]?.source).toBe("body\n");
	expect(parts[1]?.source).toBe("- one\n- two\n");
});
