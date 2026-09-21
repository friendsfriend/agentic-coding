/** @jsxImportSource @opentui/solid */

import { uiColors } from "../theme/colors";

/**
 * Left-edge block marker for a selectable row — the same selection visual the
 * list rows use (`Selectable`, `ListViewModal`, `ChangedFilesView`): a
 * two-column accent strip that is only painted while the row is marked, with a
 * one-column gap before the content so the block never sits flush against the
 * text. Rows keep their own (diff/semantic) background; the block, not a
 * full-row background fill, is what signals selection.
 *
 * `selected` marks the cursor row with the accent color, exactly like list
 * rows. `range` marks a row inside a visual selection without losing the
 * cursor (the theme's selection color). Rows outside both render the strip as
 * empty space, so layout stays stable while the marker moves.
 */
export function SelectionMarker(props: { selected: boolean; range?: boolean }) {
	return (
		<>
			<box
				backgroundColor={
					props.selected
						? uiColors.highlight
						: props.range
							? uiColors.selectionBg
							: undefined
				}
				style={{ width: 2, flexShrink: 0 }}
			/>
			<box style={{ width: 1, flexShrink: 0 }} />
		</>
	);
}
