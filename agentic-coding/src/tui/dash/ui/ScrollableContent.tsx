/** @jsxImportSource @opentui/solid */
// Shared scroll primitive (src/tui/shared/ScrollableContent.tsx) with the
// dashboard surface's legacy scrollbar colors pinned as defaults.
import {
	type ScrollableContentProps,
	ScrollableContent as SharedScrollableContent,
} from "../../shared/ScrollableContent";
import { colors } from "./colors";

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

export function ScrollableContent(props: ScrollableContentProps) {
	return (
		<SharedScrollableContent
			{...props}
			scrollbarOptions={props.scrollbarOptions ?? DASH_SCROLLBAR_OPTIONS}
		/>
	);
}

export type {
	ScrollAxis,
	ScrollableContentProps,
} from "../../shared/ScrollableContent";
export { allowsKeyboardAxis } from "../../shared/ScrollableContent";
