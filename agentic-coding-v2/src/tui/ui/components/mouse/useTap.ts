import type { MouseEvent } from "@opentui/core";
import { type RowGestureState, useRowMouse } from "./useRowMouse.ts";

/**
 * A tap on a click-only control (an expander glyph, a tab chip, a footer chip,
 * a toast): the control has no cursor, so every tap runs `onTap` and the shared
 * rule still drops drags and every non-primary button.
 *
 * It shares `useRowMouse`'s classification rather than repeating it, so a
 * control that is not a row behaves exactly like one (`tui-mouse-interaction`).
 */
export function useTap(
	onTap: () => void,
	options: {
		enabled?: () => boolean;
		gesture?: RowGestureState;
		/** Stop the tap here once it acted (a control nested in a row). */
		stopPropagation?: boolean;
	} = {},
): {
	onMouseDown: (event: MouseEvent) => void;
	onMouseUp: (event: MouseEvent) => void;
	onMouseOut: (event: MouseEvent) => void;
} {
	return useRowMouse({
		// A control that renders one line has no cursor: `selectedIndex` never
		// equals this row's index, so every tap resolves to the select branch.
		selectedIndex: () => 1,
		activatable: () => false,
		...(options.stopPropagation ? { stopPropagation: true } : {}),
		onSelect: () => {
			if (options.enabled?.() ?? true) onTap();
		},
		...(options.gesture ? { gesture: options.gesture } : {}),
	});
}
