/** @jsxImportSource @opentui/solid */

import { uiColors } from "../theme/colors";

/**
 * Left-edge block marker for a selectable row — the same selection visual the
 * list rows use (`Selectable`, `ListViewModal`, `ChangedFilesView`) and the
 * durable agent session blocks use for their prompt and tool rows: a
 * one-column line glyph over the row's own background, with a one-column gap
 * before the content so the line never sits flush against the text. Rows keep
 * their own (diff/semantic) background; the line, not a full-row background
 * fill, is what signals selection.
 *
 * `selected` marks the cursor row with the accent color, exactly like list
 * rows. `range` marks a row inside a visual selection without losing the
 * cursor (the theme's selection color). Rows outside both render the line
 * transparent, so layout stays stable while the marker moves.
 */
export function SelectionMarker(props: { selected: boolean; range?: boolean }) {
	return (
		<>
			<box
				border={["left"]}
				borderColor={
					props.selected
						? uiColors.highlight
						: props.range
							? uiColors.selectionBg
							: "transparent"
				}
				style={{ width: 1, height: "100%", flexShrink: 0 }}
			/>
			<box style={{ width: 1, flexShrink: 0 }} />
		</>
	);
}
