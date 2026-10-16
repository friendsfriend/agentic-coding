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

/** One rendered piece of a document split at its top-level block boundaries:
 * a fenced code block draws as its own text immediately, prose goes through the
 * markdown syntax pass. Each part keeps the blank lines up to the next part,
 * because a rendered part only draws the spacing that is part of its own
 * text. */
export interface MarkdownBlockPart {
	/** The part's source text, including the blank lines up to the next part. */
	readonly source: string;
	/** Fenced code: drawn as text instead of waiting for the syntax pass. */
	readonly code: boolean;
}

/** The 0-based offset each source line starts at. */
function lineStarts(content: string): number[] {
	const starts = [0];
	for (let index = 0; index < content.length; index++)
		if (content[index] === "\n") starts.push(index + 1);
	return starts;
}

/** Split a document at its top-level blocks, with each part's offset in the
 * document (the start of the line its block starts on). */
function partOffsets(content: string): {
	readonly parts: MarkdownBlockPart[];
	readonly offsets: number[];
} {
	const blocks = parseMarkdownBlocks(content);
	const lines = content.split("\n");
	const starts = lineStarts(content);
	const parts: MarkdownBlockPart[] = [];
	const offsets: number[] = [];
	for (const [index, block] of blocks.entries()) {
		const next = blocks[index + 1];
		parts.push({
			source: lines
				.slice(block.startLine - 1, next ? next.startLine - 1 : lines.length)
				.join("\n"),
			code: block.kind === "code",
		});
		offsets.push(starts[block.startLine - 1] ?? content.length);
	}
	return { parts, offsets };
}

/** Split a document into the parts it renders as (see `parseMarkdownBlocks`). */
export function markdownBlockParts(content: string): MarkdownBlockPart[] {
	return partOffsets(content).parts;
}

/**
 * The source a document's streaming tail part is drawn from.
 *
 * Everything before the tail is settled, but the tail ends at the text that has
 * arrived, so its last line is still unfinished — and the renderer draws the raw
 * source verbatim, so an unfinished trailing line is a row of its own until the
 * next character lands:
 *
 * - a document-ending newline (`body\n`) draws an empty row that the following
 *   blank line or block takes back;
 * - a bare list marker (`- `) is tokenized with a synthesized line break, so its
 *   item row appears and then merges into the item the next character starts;
 * - a partly typed closing code fence (a line of backticks shorter than the
 *   fence that closes it) is swallowed as code content, so its row disappears
 *   once the fence closes.
 *
 * A transcript that follows its newest output then grows a row and immediately
 * loses it, which reads as the live message flickering a line up and down. The
 * unfinished trailing line is therefore held back until it is finished: it comes
 * back on the frame the next character arrives, and only whitespace or a fence
 * marker that the renderer conceals anyway is withheld in the meantime.
 *
 * The settled parts are left alone: their trailing blank line is the spacing
 * between blocks, and the plain part source is what draws it.
 */
export function streamingTailSource(part: MarkdownBlockPart): string {
	const finished = part.source.replace(/\s+$/, "");
	// Only a fenced block swallows a trailing marker line as content; in prose a
	// line of backticks is the text the model wrote. The block's own opening
	// fence (the first line of the part) is not a marker being closed.
	return part.code ? finished.replace(/\n[ \t]*[`~]+$/, "") : finished;
}

/** The parts of a document being streamed, and what a later frame can reuse. */
export interface StreamingMarkdownBlockParts {
	/** The text these parts were parsed from. */
	readonly content: string;
	/** Every part of the document, in order. */
	readonly parts: readonly MarkdownBlockPart[];
	/** Offset in `content` where the last part starts. Everything before it is
	 * settled: only the last block can still grow. */
	readonly tail: number;
}

function partsOf(content: string): StreamingMarkdownBlockParts {
	const { parts, offsets } = partOffsets(content);
	return {
		content,
		parts,
		tail: offsets[offsets.length - 1] ?? content.length,
	};
}

/** Parse `content` as the next frame of a streamed document, reusing the parts
 * the previous frame had already settled when the document only grew.
 *
 * A transcript re-parses its assistant message on every host frame, and lexing
 * the whole message is the expensive half of that render. Text appended at the
 * end cannot re-open a block boundary the settled text already closed, so only
 * the tail is lexed again: the parts before it keep their identity, and the
 * renderer keeps their rows instead of rebuilding every one of them per
 * token. */
export function streamingMarkdownBlockParts(
	previous: StreamingMarkdownBlockParts | undefined,
	content: string,
): StreamingMarkdownBlockParts {
	if (
		previous &&
		previous.tail > 0 &&
		content.length >= previous.tail &&
		content.startsWith(previous.content)
	) {
		const tailText = content.slice(previous.tail);
		const { parts: tailParts, offsets } = partOffsets(tailText);
		const tail = offsets[offsets.length - 1] ?? tailText.length;
		if (tailParts.length > 0)
			return {
				content,
				parts: [...previous.parts.slice(0, -1), ...tailParts],
				tail: previous.tail + tail,
			};
	}
	return partsOf(content);
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
	const first = Math.min(
		startIndex ?? endIndex ?? 0,
		endIndex ?? startIndex ?? 0,
	);
	const last = Math.max(
		startIndex ?? endIndex ?? 0,
		endIndex ?? startIndex ?? 0,
	);
	const start = blocks[Math.min(Math.max(0, first), blocks.length - 1)];
	const end = blocks[Math.min(Math.max(0, last), blocks.length - 1)];
	if (!start) return {};
	return { start: start.startLine, end: end?.endLine ?? start.startLine };
}
