import type { MouseEvent } from "@opentui/core";
import { wheelStep } from "./clickSemantics.ts";

export type WheelDirection = "up" | "down" | "left" | "right";

export interface WheelScrollOptions {
	/** Scroll owner of the pane: the wheel scrolls *this* pane. */
	onScroll?: (direction: WheelDirection, delta: number) => void;
	/**
	 * Axis the pane scrolls. Default `"y"`: a horizontal wheel is left to an
	 * ancestor that scrolls horizontally instead of being swallowed here.
	 */
	axis?: "x" | "y";
	/**
	 * Whether the pane can act at all. A pane that is currently unable to move
	 * lets the event bubble instead of swallowing it, so the wheel still reaches
	 * an ancestor scroll owner (a list inside a scroll box never kills the
	 * wheel).
	 */
	enabled?: () => boolean;
}

/**
 * The wheel half of the shared pointer layer.
 *
 * An event the pane handles is stopped here, so the *innermost* scroll owner
 * under the pointer scrolls and the focused pane is untouched (design D7).
 *
 * (A `ScrollableContent` scroll box is not wrapped in this hook: the renderer
 * scrolls it natively, and handling the wheel twice would double the step.)
 */
export function useWheelScroll(options: WheelScrollOptions): {
	onMouseScroll: (event: MouseEvent) => void;
} {
	return {
		onMouseScroll(event) {
			const scroll = event.scroll;
			if (!scroll || !options.onScroll) return;
			if (options.enabled && !options.enabled()) return;
			const direction = scroll.direction;
			if (
				(options.axis ?? "y") === "y" &&
				(direction === "left" || direction === "right")
			)
				return;
			options.onScroll(direction, wheelStep(scroll.delta));
			event.preventDefault?.();
			event.stopPropagation?.();
		},
	};
}

/** The wheel handler for a windowed list whose keyboard scroll is selection. */
export function wheelSelectsRow(options: {
	selectedIndex: () => number;
	count: () => number;
	onSelect?: (index: number) => void;
	axis?: "x" | "y";
}): { onMouseScroll: (event: MouseEvent) => void } {
	return useWheelScroll({
		...(options.axis ? { axis: options.axis } : {}),
		enabled: () => options.onSelect !== undefined && options.count() > 0,
		onScroll: (direction, delta) => {
			if (!options.onSelect) return;
			const count = options.count();
			if (count <= 0) return;
			const step = direction === "up" || direction === "left" ? -delta : delta;
			const next = Math.max(
				0,
				Math.min(count - 1, options.selectedIndex() + step),
			);
			if (next !== options.selectedIndex()) options.onSelect?.(next);
		},
	});
}
