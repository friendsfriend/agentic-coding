/** @jsxImportSource @opentui/solid */
// Inline semantic text — the single text component for every surface.
//
// Replaces the former `HighlightedText` (semantic colour by highlight name) and
// `MatchedText` (search matches with a warning background): one component, two
// optional inputs. Pass `query` for a filtered list's active search so matches
// are marked; pass `highlight` for the semantic colour when there is no match
// styling. Callers with raw colours pass `fg` instead.
import { For } from "solid-js";
import { uiColors } from "../theme/colors";
import type { Highlight } from "./Highlight";
import { highlightColor } from "./Highlight";

/** Split `text` into matched/unmatched segments for `query` (case-insensitive). */
export function splitMatches(
	text: string,
	query: string,
): Array<{ text: string; isMatch: boolean }> {
	if (!query) return [{ text, isMatch: false }];
	const lower = text.toLowerCase();
	const q = query.toLowerCase();
	const segments: Array<{ text: string; isMatch: boolean }> = [];
	let pos = 0;
	while (pos < text.length) {
		const idx = lower.indexOf(q, pos);
		if (idx === -1) {
			segments.push({ text: text.slice(pos), isMatch: false });
			break;
		}
		if (idx > pos)
			segments.push({ text: text.slice(pos, idx), isMatch: false });
		segments.push({ text: text.slice(idx, idx + q.length), isMatch: true });
		pos = idx + q.length;
	}
	return segments;
}

export interface TextProps {
	text: string | number;
	/** Semantic colour; ignored when `fg` is given. */
	highlight?: Highlight;
	/** Raw colour override (legacy call sites that pass a theme colour). */
	fg?: string;
	/** Active search query: matching segments get the warning background. */
	query?: string;
	attributes?: number;
}

export function Text(props: TextProps) {
	const query = () => props.query ?? "";
	const color = () => props.fg ?? highlightColor(props.highlight);
	return (
		<text fg={color()} attributes={props.attributes ?? 0}>
			<For each={splitMatches(String(props.text), query())}>
				{(segment) => (
					<span
						style={
							segment.isMatch
								? { fg: uiColors.bgBase, bg: uiColors.warning }
								: { fg: color() }
						}
					>
						{segment.text}
					</span>
				)}
			</For>
		</text>
	);
}
