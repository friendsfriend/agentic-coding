/** @jsxImportSource @opentui/solid */
// Shared selection primitive (src/tui/shared/Selectable.tsx) with the
// observability surface's legacy defaults: the list scrollbox is not a focus
// target and uses the muted text color for the scrollbar thumb.
import {
	Selectable,
	type SelectableListProps,
	SelectableList as SharedSelectableList,
} from "../../shared/Selectable";
import { uiColors } from "../ui/colors";

export type { SelectableListProps } from "../../shared/Selectable";
export { Selectable };

const OTEL_SCROLLBAR_OPTIONS = {
	showArrows: false,
	trackOptions: {
		get backgroundColor() {
			return uiColors.bgSurface0;
		},
		get foregroundColor() {
			return uiColors.textMuted;
		},
	},
} as const;

export function SelectableList<T>(props: SelectableListProps<T>) {
	return (
		<SharedSelectableList
			{...props}
			focusable={props.focusable ?? false}
			scrollbarOptions={props.scrollbarOptions ?? OTEL_SCROLLBAR_OPTIONS}
		/>
	);
}
