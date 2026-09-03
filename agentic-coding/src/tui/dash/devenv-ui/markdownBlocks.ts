import { Lexer } from "marked";

/**
 * A top-level Markdown block extracted from a document, carrying the 1-based
 * (inclusive) source-line range it was parsed from.
 *
 * Blocks are derived from the same `marked` token stream OpenTUI's
 * `<markdown>` renderable consumes (`Lexer.lex(content, { gfm: true })`), so a
 * block's rendered form lines up with what the renderer shows and its
 * source-line range stays available for comment anchoring.
 */
export interface MarkdownBlock {
	/** marked token type, e.g. "heading", "paragraph", "list", "table". */
	kind: string;
	/** 1-based line of the block's first source line. */
	startLine: number;
	/** 1-based line of the block's last source line (inclusive). */
	endLine: number;
	/** The block's raw source text (the token's `raw`). */
	source: string;
}

/**
 * Parse a Markdown document into ordered top-level blocks.
 *
 * Blank-line `space` tokens are skipped: they carry no selectable content and
 * would otherwise split neighboring blocks apart. Token raws occasionally fold
 * the following blank line into a block (marked 17 does this for headings,
 * tables, and lists), so `endLine` retreats over trailing blank lines while
 * `source` keeps the raw text for rendering.
 */
export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
	if (!content) return [];
	// marked normalizes \r\n / \r to \n before tokenizing; normalize first so
	// token raw offsets line up with the source-line numbers we report.
	const normalized = content.replace(/\r\n?/g, "\n");
	// Sorted 1-based line-start offsets; `\n` starts a new line at i+1.
	const lineStarts: number[] = [0];
	for (let i = 0; i < normalized.length; i++) {
		if (normalized[i] === "\n") lineStarts.push(i + 1);
	}
	const lineFor = (offset: number): number => {
		let low = 0;
		let high = lineStarts.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (lineStarts[mid] <= offset) low = mid + 1;
			else high = mid;
		}
		return low;
	};

	const blocks: MarkdownBlock[] = [];
	let offset = 0;
	for (const token of Lexer.lex(normalized, { gfm: true })) {
		const raw = token.raw;
		if (token.type === "space") {
			offset += raw.length;
			continue;
		}
		const startLine = lineFor(offset);
		blocks.push({
			kind: token.type,
			startLine,
			endLine: lastContentLine(raw, startLine),
			source: raw,
		});
		offset += raw.length;
	}
	return blocks;
}

/** Last source line that carries content within a token's raw. */
function lastContentLine(raw: string, startLine: number): number {
	const lines = raw.split("\n");
	let index = lines.length - 1;
	// A raw ending in "\n" yields a trailing "" entry that terminates the last
	// line instead of starting an extra one.
	while (index > 0 && lines[index] === "") index--;
	// The tokenizer folds the following blank line into some raws (headings,
	// tables, lists); it is spacing, not block content.
	while (index > 0 && lines[index].trim() === "") index--;
	return startLine + index;
}

/**
 * Map a selection of block indices (single block or a visual range) to the
 * source-line range it anchors: the first block's `startLine` through the last
 * block's `endLine`. Returns `{ start: undefined, end: undefined }` when no
 * block is selected so callers can keep uncommentable selections
 * distinguishable from line 1.
 */
export function blockSelectionToLines(
	blocks: readonly MarkdownBlock[],
	startIndex: number | undefined,
	endIndex: number | undefined,
): { start?: number; end?: number } {
	if (!blocks.length) return {};
	const first = Math.min(startIndex ?? endIndex ?? 0, endIndex ?? startIndex ?? 0);
	const last = Math.max(startIndex ?? endIndex ?? 0, endIndex ?? startIndex ?? 0);
	const start = blocks[Math.min(Math.max(0, first), blocks.length - 1)];
	const end = blocks[Math.min(Math.max(0, last), blocks.length - 1)];
	if (!start) return {};
	return { start: start.startLine, end: end?.endLine ?? start.startLine };
}