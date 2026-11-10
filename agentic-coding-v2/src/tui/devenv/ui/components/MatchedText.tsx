/** @jsxImportSource @opentui/solid */
// Compatibility wrapper: `Text` owns the implementation (semantic colour plus
// search-match marking). Kept so existing call sites keep working while they
// migrate to `Text` directly.
import { Text } from "./Text.tsx";

export { splitMatches } from "./Text.tsx";

export interface MatchedTextProps {
	text: string;
	query?: string;
	fg: string;
	attributes?: number;
}

/** @deprecated Use `Text` with `fg` and `query`. */
export function MatchedText(props: MatchedTextProps) {
	return (
		<Text
			text={props.text}
			fg={props.fg}
			{...(props.query !== undefined ? { query: props.query } : {})}
			{...(props.attributes !== undefined
				? { attributes: props.attributes }
				: {})}
		/>
	);
}
