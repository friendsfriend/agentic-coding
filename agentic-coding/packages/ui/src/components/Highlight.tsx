/** @jsxImportSource @opentui/solid */

import { uiColors } from "../theme/colors";
import { Text } from "./Text";

export type Highlight =
	| "primary"
	| "secondary"
	| "positive"
	| "negative"
	| "warning"
	| "accent"
	| "highlight"
	| "highlight1"
	| "highlight2"
	| "highlight3";
export function highlightForIndex(index: number): Highlight {
	return (["highlight1", "highlight2", "highlight3"] as Highlight[])[
		Math.max(0, index) % 3
	];
}
export function highlightColor(value?: Highlight) {
	switch (value) {
		case "positive":
			return uiColors.success;
		case "negative":
			return uiColors.error;
		case "warning":
			return uiColors.warning;
		case "secondary":
			return uiColors.textMuted;
		case "highlight2":
			return uiColors.primary;
		case "highlight3":
			return uiColors.info;
		case "accent":
		case "highlight":
		case "highlight1":
			return uiColors.accent;
		default:
			return uiColors.textPrimary;
	}
}
export interface HighlightedTextProps {
	text: string | number;
	highlight?: Highlight;
	attributes?: number;
}
/** @deprecated Use `Text` (same component, `highlight` prop). Kept so existing
 * call sites keep working while they migrate. */
export function HighlightedText(props: HighlightedTextProps) {
	return (
		<Text
			text={props.text}
			{...(props.highlight !== undefined ? { highlight: props.highlight } : {})}
			{...(props.attributes !== undefined
				? { attributes: props.attributes }
				: {})}
		/>
	);
}
