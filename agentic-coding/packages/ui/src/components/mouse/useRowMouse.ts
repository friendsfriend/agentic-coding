import type { MouseEvent } from "@opentui/core";
import {
	classifyPointerGesture,
	isPrimaryPointerButton,
	type RowAction,
	resolveRowInteraction,
	type TapRecord,
} from "./clickSemantics.ts";

/**
 * The Solid binding of {@link resolveRowInteraction}: spread the returned
 * handlers onto a row box and it selects on a tap, activates a tap on the
 * already-selected row (or a double tap), and ignores drags, right clicks and
 * middle clicks.
 *
 * There is no signal and no handler on pointer *move*: the down sample lives in
 * the gesture state, so a pointer move re-renders nothing
 * (`tui-input-responsiveness`).
 */
export interface RowMouseOptions {
	/**
	 * Absolute row index; 0 for a row component that renders one row. A row whose
	 * position can move under a stable instance (a filtered list keyed by
	 * identity) passes a getter, which is resolved on every event.
	 */
	index?: number | (() => number);
	/**
	 * Stop the tap here once it acted, for a control nested inside a selectable
	 * row (an expander glyph): one gesture runs one action (design D2).
	 */
	stopPropagation?: boolean;
	/** Current cursor of the list; defaults to this row. */
	selectedIndex?: () => number;
	/** Whether the surface binds an activation for this row. */
	activatable?: () => boolean;
	/** Run on the keyboard's "select" action (`j`/`k`). */
	onSelect?: (index: number) => void;
	/** Run on the keyboard's "activate" action (`Enter`). */
	onActivate?: (index: number) => void;
	/**
	 * Gesture state shared by every row of one list. A list recreates its row
	 * instances when the window moves or a store replaces a row, so per-row state
	 * would drop a press that is still in flight; the list owns one holder and
	 * hands it to every row it renders.
	 */
	gesture?: RowGestureState;
}

/** One gesture in flight: the pressed row/cell and the last tap, per list. */
export interface RowGestureState {
	down?: RowDownSample;
	lastTap?: TapRecord;
}

/**
 * The press: the row instance it landed on, the cell, and the index that
 * instance reported then. The instance decides whether the release belongs to
 * the same row (a recreated row never does), the cell decides tap vs drag, and
 * the index is resolved live on the release so a row whose position moved under
 * a stable instance still acts on itself.
 */
export interface RowDownSample {
	readonly instance?: unknown;
	readonly index: number;
	readonly x: number;
	readonly y: number;
}

export interface RowMouseHandlers {
	onMouseDown: (event: MouseEvent) => void;
	onMouseUp: (event: MouseEvent) => void;
	onMouseOut: () => void;
}

export function useRowMouse(options: RowMouseOptions): RowMouseHandlers {
	const state: RowGestureState = options.gesture ?? {};
	const rowIndex = (): number =>
		typeof options.index === "function"
			? options.index()
			: (options.index ?? 0);
	return {
		onMouseDown(event) {
			if (!isPrimaryPointerButton(event.button)) {
				state.down = undefined;
				return;
			}
			state.down = {
				instance: event.currentTarget,
				index: rowIndex(),
				x: event.x,
				y: event.y,
			};
		},
		onMouseUp(event) {
			const start = state.down;
			state.down = undefined;
			if (!isPrimaryPointerButton(event.button)) return;
			if (!start) return;
			// A release that names neither the instance nor the row the press
			// belonged to is not this row's tap: the pointer moved to another row.
			// A row the store replaced (same position, new instance) and a row whose
			// position moved under a stable instance both still complete their tap.
			if (
				start.instance !== undefined &&
				event.currentTarget !== undefined &&
				start.instance !== event.currentTarget &&
				start.index !== rowIndex()
			)
				return;
			if (classifyPointerGesture(start, { x: event.x, y: event.y }) !== "tap")
				return;
			// The live index: a row whose position moved under a stable instance
			// acts on the row the pointer is over now.
			const index = rowIndex();
			const resolved = resolveRowInteraction({
				index,
				selectedIndex: options.selectedIndex?.() ?? index,
				activatable: options.activatable?.() ?? false,
				...(state.lastTap ? { lastTap: state.lastTap } : {}),
				...(event.currentTarget === undefined
					? {}
					: { instance: event.currentTarget }),
				now: Date.now(),
			});
			state.lastTap = resolved.lastTap;
			if (resolved.action === "none") return;
			if (options.stopPropagation) event.stopPropagation?.();
			runAction(resolved.action, index, options);
		},
		/** The pointer left the row: the press it started here is over. */
		onMouseOut() {
			state.down = undefined;
		},
	};
}

function runAction(
	action: RowAction,
	index: number,
	options: RowMouseOptions,
): void {
	if (action === "select") options.onSelect?.(index);
	else if (action === "activate") options.onActivate?.(index);
}
