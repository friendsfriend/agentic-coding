/** @jsxImportSource @opentui/solid */
// Shared scroll primitive (src/tui/shared/ScrollableContent.tsx) with the
// observability surface's legacy defaults: scrollboxes are not focus targets
// and the scrollbar uses the muted text color for the thumb.
import {
	type ScrollableContentProps,
	ScrollableContent as SharedScrollableContent,
} from "../../shared/ScrollableContent";
import { uiColors } from "../ui/colors";

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

export function ScrollableContent(props: ScrollableContentProps) {
	return (
		<SharedScrollableContent
			{...props}
			focusable={props.focusable ?? false}
			scrollbarOptions={props.scrollbarOptions ?? OTEL_SCROLLBAR_OPTIONS}
		/>
	);
}

export type { ScrollableContentProps } from "../../shared/ScrollableContent";
export { allowsKeyboardAxis } from "../../shared/ScrollableContent";
