/** @jsxImportSource @opentui/solid */
// Shared highlight semantics (src/tui/shared/Highlight.tsx), with the
// observability surface's legacy default: an unspecified or "primary"
// highlight resolves to the theme primary instead of the shared text color.
import {
	type Highlight,
	highlightColor as sharedHighlightColor,
} from "../../shared/Highlight";
import { uiColors } from "../ui/colors";

export type { Highlight };

export function highlightColor(value?: Highlight) {
	return value === undefined || value === "primary"
		? uiColors.primary
		: sharedHighlightColor(value);
}

export function HighlightedText(props: {
	text: string | number;
	highlight?: Highlight;
	attributes?: number;
}) {
	return (
		<text
			fg={highlightColor(props.highlight)}
			attributes={props.attributes ?? 0}
		>
			{String(props.text)}
		</text>
	);
}
