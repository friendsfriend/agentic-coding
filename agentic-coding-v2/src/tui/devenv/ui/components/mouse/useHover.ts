import type { MouseEvent } from "@opentui/core";
import { createSignal } from "solid-js";
import { pointerInside } from "./pointer.ts";

export interface HoverHandlers {
	onMouseOver: (event: MouseEvent) => void;
	onMouseOut: (event: MouseEvent) => void;
}

export interface HoverState extends HoverHandlers {
	/** Whether the pointer is over the surface that spread the handlers. */
	hovered: () => boolean;
}

/**
 * Pointer feedback for a raised surface: enter lifts it, leave settles it.
 *
 * Only over/out are bound — a pointer move re-renders nothing. A transition
 * from the surface to one of its children also emits an out/over pair; the
 * bounds check keeps the surface hovered while the pointer is still inside it.
 *
 * `onLeave` lets one box own both a gesture and its hover state: the same out
 * event reaches the gesture and the surface, each with its own bounds check.
 * A child transition stays inside, so neither the press nor the surface is
 * settled by it.
 */
export function useHover(onLeave?: (event: MouseEvent) => void): HoverState {
	const [hovered, setHovered] = createSignal(false);
	return {
		hovered,
		onMouseOver() {
			setHovered(true);
		},
		onMouseOut(event) {
			const inside = pointerInside(event);
			if (!inside) setHovered(false);
			onLeave?.(event);
		},
	};
}
