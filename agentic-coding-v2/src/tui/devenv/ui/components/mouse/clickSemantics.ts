/**
 * Pure pointer semantics for the shared mouse layer (`tui-mouse-interaction`).
 *
 * Every surface resolves a pointer gesture through this module: nothing here
 * imports a renderer, a signal or a timer, so the rules can be unit-tested with
 * synthetic samples and one surface can never invent a second behaviour for
 * the same gesture.
 *
 * The decided semantics (design D2/D3):
 *
 * | Gesture | Meaning |
 * | --- | --- |
 * | Tap a row that is not selected | select it (`j`/`k`) |
 * | Tap the selected row of an activatable list | activate it (`Enter`) |
 * | Double tap (≤ {@link DOUBLE_TAP_WINDOW_MS}, same row) | select + activate once |
 * | Drag (any cell change between down and up) | never a tap |
 * | Right/middle click, other buttons | ignored |
 */

/** Two taps on the same row within this window count as a double tap. */
export const DOUBLE_TAP_WINDOW_MS = 400;

/** The left button, as `MouseButton.LEFT` of the renderer reports it. */
export const PRIMARY_POINTER_BUTTON = 0;

/** A pointer sample: the cell a press or release landed on. */
export interface PointerSample {
	readonly x: number;
	readonly y: number;
}

export type PointerGesture = "tap" | "drag" | "none";

/** Only the primary (left) button is a gesture; right/middle are ignored. */
export function isPrimaryPointerButton(button: number | undefined): boolean {
	return button === PRIMARY_POINTER_BUTTON;
}

/**
 * Classify a down/up pair: a tap needs the same cell as the down, so a drag
 * (text selection, a release that moved) is never a tap. Which row the pair
 * belongs to is the caller's check (`useRowMouse` compares the row index),
 * because a windowed list recreates row instances and renderable identity is
 * not stable across a window move.
 */
export function classifyPointerGesture(
	down: PointerSample | undefined,
	up: PointerSample,
): PointerGesture {
	if (!down) return "none";
	return down.x === up.x && down.y === up.y ? "tap" : "drag";
}

/** The last tap on a row, as the list's gesture holder remembers it. */
export interface TapRecord {
	readonly index: number;
	readonly at: number;
	/**
	 * The row instance that was tapped. Two rows can report the same index (a
	 * one-row component encodes 0), so the instance — when both taps carry one —
	 * is what makes a pair a double tap on the *same* row.
	 */
	readonly instance?: unknown;
	/** Whether that tap already activated the row (so a double tap is one act). */
	readonly activated?: boolean;
}

/** True when the previous tap hit the same row inside the double-tap window. */
export function isDoubleTap(
	lastTap: TapRecord | undefined,
	index: number,
	now: number,
): boolean {
	if (!lastTap || lastTap.index !== index) return false;
	const elapsed = now - lastTap.at;
	return elapsed >= 0 && elapsed <= DOUBLE_TAP_WINDOW_MS;
}

export type RowAction = "select" | "activate" | "none";

export interface RowInteractionInput {
	/** Absolute index of the tapped row, as the list renderer reports it. */
	index: number;
	selectedIndex: number;
	/**
	 * The surface binds an activation for this row (`Enter` does something
	 * here). A purely informational list leaves it false and only selects.
	 */
	activatable?: boolean;
	lastTap?: TapRecord;
	/** The row instance this tap landed on, when the caller has one. */
	instance?: unknown;
	now: number;
}

export interface RowInteraction {
	action: RowAction;
	/** Record the caller keeps and hands back on the next tap of that row. */
	lastTap: TapRecord;
}

/**
 * Resolve a tap on a list row into the action the keyboard would have taken:
 * select while the row is not the cursor, activate when the cursor is already
 * there. Selection is synchronous, so a double tap selects on its first tap and
 * activates on its second — exactly once, and never on a row the pointer did
 * not name.
 *
 * The second tap of a double tap carries the window: it activates, and a tap
 * that follows an activation of the same row inside the window does nothing, so
 * an accidental double click can never run a dialog's confirm action twice.
 */
export function resolveRowInteraction(
	input: RowInteractionInput,
): RowInteraction {
	const { index, selectedIndex, now } = input;
	const record: TapRecord = {
		index,
		at: now,
		...(input.instance === undefined ? {} : { instance: input.instance }),
	};
	if (index < 0) return { action: "none", lastTap: record };
	const activatable = input.activatable ?? false;
	const selected = index === selectedIndex;
	if (!activatable || !selected) return { action: "select", lastTap: record };
	if (
		input.lastTap?.activated === true &&
		isDoubleTap(input.lastTap, index, now) &&
		sameRow(input.lastTap, input.instance)
	)
		return { action: "none", lastTap: input.lastTap };
	return {
		action: "activate",
		lastTap: { ...record, activated: true },
	};
}

/** Two taps are the same row when neither instance is known or they match. */
function sameRow(lastTap: TapRecord, instance: unknown): boolean {
	if (lastTap.instance === undefined || instance === undefined) return true;
	return lastTap.instance === instance;
}

/** A wheel notch: at least one row, however coarse the device reports it. */
export function wheelStep(delta: number | undefined): number {
	const magnitude = Math.abs(delta ?? 1);
	return Math.max(1, Math.round(magnitude));
}

/**
 * Move a list cursor by `direction`/`delta` rows, clamped to the list — the
 * default windowed-list wheel handler, so a wheel over a list moves the cursor
 * exactly like `j`/`k` does.
 */
export function moveRowIndex(
	index: number,
	direction: "up" | "down" | "left" | "right",
	delta: number,
	count: number,
): number {
	if (count <= 0) return 0;
	const step = wheelStep(delta);
	const next =
		direction === "up" || direction === "left" ? index - step : index + step;
	return Math.max(0, Math.min(count - 1, next));
}
