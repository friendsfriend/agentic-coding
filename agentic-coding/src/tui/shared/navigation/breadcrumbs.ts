// Breadcrumb layout (replace-nested-tabs-with-page-navigation, task 2.1).
//
// One bounded row rendered from structural ancestors. The row is pure layout:
// given the ancestor chain, the available width and the focused ancestor index,
// it returns the segments to render. Narrow widths collapse the middle
// ancestors into a single `…` segment while the current location stays visible
// and the focused ancestor is always readable (so keyboard access to a hidden
// ancestor works without horizontal overflow).
import { pageLabel, type Route } from "../routes";

export interface BreadcrumbSegment {
	label: string;
	/** Route this segment navigates to; absent for the collapsed placeholder. */
	route?: Route;
	/** The segment stands for collapsed ancestors. */
	collapsed?: boolean;
	/** First..last indices of the collapsed range (inclusive). */
	collapsedRange?: { start: number; end: number };
	/** The keyboard cursor is on this segment. */
	focused: boolean;
}

const SEPARATOR = " › ";

/** Total rendered width of the row. */
export function breadcrumbWidth(
	segments: readonly BreadcrumbSegment[],
): number {
	const labels = segments.reduce(
		(total, segment) => total + segment.label.length,
		0,
	);
	return labels + SEPARATOR.length * Math.max(0, segments.length - 1);
}

function clipLabel(label: string, max: number): string {
	if (max <= 0) return "";
	if (label.length <= max) return label;
	return max === 1 ? "…" : `${label.slice(0, max - 1)}…`;
}

/**
 * Clip the current location's label until the row fits `width`. The current
 * segment is the one that names a resource, so it is the one that yields rather
 * than the ancestors or the row overflowing.
 */
function fitRow(
	segments: BreadcrumbSegment[],
	width: number,
): BreadcrumbSegment[] {
	if (segments.length === 0) return segments;
	const lastIndex = segments.length - 1;
	const last = segments[lastIndex];
	const overflow = breadcrumbWidth(segments) - width;
	if (overflow <= 0) return segments;
	return [
		...segments.slice(0, lastIndex),
		{ ...last, label: clipLabel(last.label, last.label.length - overflow) },
	];
}

/**
 * Lay out the ancestor chain for `width` columns. `focusedIndex` indexes the
 * logical chain (not the rendered segments); when it points inside a collapsed
 * range, the placeholder renders that ancestor's label so it stays readable.
 */
export function breadcrumbSegments(
	routes: readonly Route[],
	width: number,
	focusedIndex = routes.length - 1,
): BreadcrumbSegment[] {
	const labels = routes.map(pageLabel);
	const full = (): BreadcrumbSegment[] =>
		routes.map((route, index) => ({
			label: labels[index],
			route,
			focused: index === focusedIndex,
		}));
	if (width <= 0 || routes.length === 0) return [];
	if (routes.length === 1) return fitRow(full(), width);
	if (breadcrumbWidth(full()) <= width) return full();

	// Collapse the middle: keep the first and last ancestor, represent the rest
	// with one placeholder that still carries its logical range.
	const last = routes.length - 1;
	const collapsedRange = { start: 1, end: last - 1 };
	const hidden = focusedIndex >= 1 && focusedIndex < last;
	const placeholder: BreadcrumbSegment = {
		label: hidden ? labels[focusedIndex] : "…",
		collapsed: true,
		collapsedRange,
		focused: hidden,
	};
	const segments: BreadcrumbSegment[] = [
		{ label: labels[0], route: routes[0], focused: focusedIndex === 0 },
		...(collapsedRange.start <= collapsedRange.end ? [placeholder] : []),
		{
			label: labels[last],
			route: routes[last],
			focused: focusedIndex === last,
		},
	];
	return fitRow(segments, width);
}

/** Which segments a left/right cursor move can land on. */
export { SEPARATOR as BREADCRUMB_SEPARATOR };
