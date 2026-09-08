/** @jsxImportSource @opentui/solid */
// Shared selection primitive (src/tui/shared/Selectable.tsx) with the
// dashboard surface's legacy scrollbar colors pinned for the list scrollbox.
import {
	Selectable,
	type SelectableListProps,
	SelectableList as SharedSelectableList,
} from "../../shared/Selectable";
import { colors } from "./colors";

export type { SelectableListProps } from "../../shared/Selectable";
export { Selectable };

const DASH_SCROLLBAR_OPTIONS = {
	showArrows: false,
	trackOptions: {
		get backgroundColor() {
			return colors.surface0;
		},
		get foregroundColor() {
			return colors.overlay0;
		},
	},
} as const;

export function SelectableList<T>(props: SelectableListProps<T>) {
	return (
		<SharedSelectableList
			{...props}
			scrollbarOptions={props.scrollbarOptions ?? DASH_SCROLLBAR_OPTIONS}
		/>
	);
}
