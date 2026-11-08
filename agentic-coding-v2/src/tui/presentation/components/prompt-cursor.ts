import {
	type OptimizedBuffer,
	parseColor,
	type TextareaRenderable,
} from "@opentui/core";
import { uiColors } from "../theme/colors.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const PROMPT_CURSOR_BLINK_MS = 600;

/** Monotonic time, not frame count: streaming redraws never restart the blink. */
export function createPromptCursorBlink(
	now: () => number = () => performance.now(),
) {
	let epoch = now();
	return {
		visible: () =>
			Math.floor(Math.max(0, now() - epoch) / PROMPT_CURSOR_BLINK_MS) % 2 === 0,
		reset: () => {
			epoch = now();
		},
	};
}

/** Final-frame cursor paint. Native editor paint runs after some scene hooks,
 * so a parent renderAfter overlay is not a reliable place for an input cursor.
 * Change only colors: retain the exact native glyph, including grapheme IDs. */
export function paintPromptCursor(
	buffer: OptimizedBuffer,
	editor: TextareaRenderable,
): void {
	if (editor.isDestroyed || !editor.focused) return;
	// Visual cursor coordinates are already relative to the editor viewport.
	const cursor = editor.visualCursor;
	const x = editor.screenX + cursor.visualCol;
	const y = editor.screenY + cursor.visualRow;
	if (
		cursor.visualCol < 0 ||
		cursor.visualRow < 0 ||
		cursor.visualCol >= editor.width ||
		cursor.visualRow >= editor.height ||
		x < 0 ||
		y < 0 ||
		x >= buffer.width ||
		y >= buffer.height
	)
		return;
	const text = editor.editBuffer.getTextRange(cursor.offset, cursor.offset + 2);
	const glyph =
		graphemes.segment(text)[Symbol.iterator]().next().value?.segment ?? " ";
	const width = Math.min(
		Math.max(1, Bun.stringWidth(glyph)),
		editor.width - cursor.visualCol,
		buffer.width - x,
	);
	const foreground = parseColor(uiColors.bgMantle).buffer;
	const background = parseColor(uiColors.textPrimary).buffer;
	buffer.withBuffers((cells) => {
		for (let column = 0; column < width; column++) {
			const offset = (y * cells.width + x + column) * 4;
			cells.fg.set(foreground, offset);
			cells.bg.set(background, offset);
		}
	});
}
