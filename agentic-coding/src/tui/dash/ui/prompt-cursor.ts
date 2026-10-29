import { uiColors } from "@agentic-coding/ui";
import {
	type OptimizedBuffer,
	parseColor,
	type TextareaRenderable,
} from "@opentui/core";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Paint the cursor with the editor, not the terminal's hide/show cursor
 * protocol. Terminals without atomic synchronized output otherwise flash the
 * hardware cursor on every streaming/animation frame, even with blink off. */
export function paintPromptCursor(
	this: TextareaRenderable,
	buffer: OptimizedBuffer,
): void {
	if (!this.focused) return;
	const cursor = this.visualCursor;
	const viewport = this.editorView.getViewport();
	const x = cursor.visualCol - viewport.offsetX;
	const y = cursor.visualRow - viewport.offsetY;
	if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
	const text = this.editBuffer.getTextRange(cursor.offset, cursor.offset + 2);
	const glyph =
		graphemes.segment(text)[Symbol.iterator]().next().value?.segment ?? " ";
	const printable =
		glyph === "\n" || glyph === "\t" || glyph === "\r" ? " " : glyph;
	buffer.drawText(
		printable,
		this.screenX + x,
		this.screenY + y,
		parseColor(uiColors.bgMantle),
		parseColor(uiColors.textPrimary),
	);
}
