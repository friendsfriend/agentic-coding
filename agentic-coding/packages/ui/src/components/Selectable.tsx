/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "solid-js";
import { uiColors } from "../theme/colors";
import { useModalContentLines } from "./GenericModal.tsx";
import { hostBodyLines } from "./hostChrome.ts";
import { ScrollableList } from "./ScrollableList.tsx";

/** A value or a reactive getter for it; both dash (plain values) and
 * observability (accessors) callers are supported by read(). */
type Value<T> = T | (() => T);
const read = <T,>(value: Value<T> | undefined, fallback: T): T =>
	typeof value === "function" ? (value as () => T)() : (value ?? fallback);

/**
 * Row chrome for a selectable list, matching the devenv work-item rows (issues,
 * change requests) and the modal list rows: a two-column accent strip that is
 * only painted while the row is selected, and the selected surface behind it.
 * Rows pad themselves, so callers keep control of their own indentation.
 */
export function Selectable(props: {
	selected: boolean;
	children?: JSX.Element;
	backgroundColor?: string;
	indicatorColor?: string;
	height?: number;
	onMouseUp?: () => void;
}) {
	const background = () =>
		props.selected
			? uiColors.bgSurface0
			: (props.backgroundColor ?? uiColors.bgMantle);
	return (
		<box
			onMouseUp={props.onMouseUp}
			width="100%"
			flexDirection="row"
			flexShrink={0}
			alignItems="stretch"
			backgroundColor={background()}
			style={props.height === undefined ? undefined : { height: props.height }}
		>
			<box
				width={2}
				height="100%"
				flexShrink={0}
				backgroundColor={
					props.selected
						? (props.indicatorColor ?? uiColors.highlight)
						: background()
				}
			/>
			<box flexGrow={1} minWidth={0} flexDirection="column">
				{props.children}
			</box>
		</box>
	);
}

export interface SelectableListProps<T> {
	items: T[];
	selectedIndex: Value<number>;
	itemHeight?: number;
	renderItem: (item: T, selected: boolean, index: number) => JSX.Element;
	onSelect?: (index: number) => void;
	backgroundColor?: (item: T, index: number) => string | undefined;
	/** Rows the list may paint. Defaults to the dialog's content area, then the
	 * host body. Pass it when the list has chrome of its own above it. */
	availableLines?: number;
	/** Lines per row for the window arithmetic when the rows size themselves.
	 * Only the window uses it, so a conservative value keeps the cursor inside
	 * the window; rows taller than the estimate scroll in whole rows instead. */
	estimatedItemHeight?: number;
}

/**
 * Selection list on the windowed paradigm (`ScrollableList`): the rows that fit
 * are rendered, and the window follows the cursor. Nothing here uses a scroll
 * box — an OpenTUI scroll bar clamps its own position to zero whenever a layout
 * pass sees the content before it has been measured, which resets both the
 * offset and the painted rows (see the ScrollBox notes in `ScrollableList`).
 *
 * The window needs to know how many lines it may paint. It measures the box it
 * is given once the layout has run (`onSizeChange`), and until then falls back
 * to the enclosing dialog's content lines or the host body, so the first frame
 * is close and every later frame exact.
 */
export function SelectableList<T>(props: SelectableListProps<T>) {
	const dimensions = useTerminalDimensions();
	const modalLines = useModalContentLines();
	const selectedIndex = () => read(props.selectedIndex, 0);
	const itemHeight = () => props.itemHeight ?? 1;
	return (
		<ScrollableList
			items={props.items}
			selectedIndex={selectedIndex()}
			availableLines={
				props.availableLines ??
				modalLines?.() ??
				hostBodyLines(dimensions().height)
			}
			estimatedItemHeight={props.estimatedItemHeight ?? itemHeight()}
			showScrollIndicator={false}
			renderItem={(item, isSelected, index) => (
				<Selectable
					height={props.itemHeight}
					onMouseUp={() => props.onSelect?.(index)}
					selected={isSelected()}
					backgroundColor={props.backgroundColor?.(item, index)}
				>
					{props.renderItem(item, isSelected(), index)}
				</Selectable>
			)}
		/>
	);
}
