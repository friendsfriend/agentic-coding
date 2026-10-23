/** @jsxImportSource @opentui/solid */

import type { JSX } from "solid-js";
import { useTerminalDimensions } from "../hooks/useTerminalDimensions.ts";
import { uiColors } from "../theme/colors";
import { useModalContentLines } from "./GenericModal.tsx";
import { hostBodyLines } from "./hostChrome.ts";
import { useHover } from "./mouse/useHover.ts";
import { type RowGestureState, useRowMouse } from "./mouse/useRowMouse.ts";
import { ScrollableList } from "./ScrollableList.tsx";

/** A value or a reactive getter for it; both dash (plain values) and
 * observability (accessors) callers are supported by read(). */
type Value<T> = T | (() => T);
const read = <T,>(value: Value<T> | undefined, fallback: T): T =>
	typeof value === "function" ? (value as () => T)() : (value ?? fallback);

/**
 * Row chrome for a selectable list, matching the devenv work-item rows (issues,
 * change requests), the modal list rows and the durable agent session blocks:
 * a one-column left line that is only painted while the row is selected, one
 * empty column between it and the content, and the selected surface behind
 * both. Rows pad themselves, so callers keep control of their own indentation.
 */
export function Selectable(props: {
	selected: boolean;
	children?: JSX.Element;
	backgroundColor?: string;
	/** Surface for an unselected row under the pointer. Defaults to one lift
	 * above the resting row; `false` keeps a deliberately static row. Selected
	 * rows keep the selection surface, as opencode's tabs do. */
	hoverBackground?: string | false;
	indicatorColor?: string;
	height?: number;
	/** A tap on the row (`select`): the legacy "row was clicked" handler. */
	onMouseUp?: () => void;
	/**
	 * The row's activation (`Enter`): when it is bound, a tap on the
	 * *already-selected* row activates instead of re-selecting. A row without
	 * one keeps its old behavior and runs `onMouseUp` on every tap.
	 */
	onActivate?: () => void;
	/** The list's gesture holder, so a recreated row still completes its tap. */
	gesture?: RowGestureState;
}) {
	// One tap rule for every row in the TUI (`tui-mouse-interaction`): select on a
	// tap, activate a tap on the selected row, ignore drags and other buttons.
	const mouse = useRowMouse({
		...(props.gesture ? { gesture: props.gesture } : {}),
		selectedIndex: () => (props.selected ? 0 : 1),
		activatable: () => props.onActivate !== undefined,
		onSelect: () => props.onMouseUp?.(),
		onActivate: () => (props.onActivate ?? props.onMouseUp)?.(),
	});
	// The same surface owns the gesture and the hover: its out event settles the
	// pointer and cancels a press that started on the row.
	const hover = useHover(mouse.onMouseOut);
	const hoverBackground = () =>
		props.hoverBackground === false
			? undefined
			: (props.hoverBackground ?? uiColors.bgHover);
	const background = () =>
		props.selected
			? uiColors.bgSurface0
			: hover.hovered()
				? (hoverBackground() ?? props.backgroundColor ?? uiColors.bgMantle)
				: (props.backgroundColor ?? uiColors.bgMantle);
	return (
		<box
			{...mouse}
			{...hover}
			width="100%"
			flexDirection="row"
			flexShrink={0}
			alignItems="stretch"
			backgroundColor={background()}
			style={props.height === undefined ? undefined : { height: props.height }}
		>
			{/* The selection marker is the same left line glyph the agent session
			    view uses for its prompt and tool blocks: a one-column border over
			    the row's own background, transparent while unselected. */}
			<box
				border={["left"]}
				borderColor={
					props.selected
						? (props.indicatorColor ?? uiColors.highlight)
						: "transparent"
				}
				style={{ width: 1, height: "100%", flexShrink: 0 }}
			/>
			{/* One empty column between the marker line and the content, so the
			    selection line never sits flush against the text. */}
			<box width={1} height="100%" flexShrink={0} />
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
	/** Hover surface for every row; forwarded to the row's `Selectable`.
	 * Defaults to the shared lift; `false` keeps the list static. */
	hoverBackground?: string | false;
	/** Rows the list may paint. Defaults to the dialog's content area, then the
	 * host body. Pass it when the list has chrome of its own above it. */
	availableLines?: number;
	/** Lines per row for the window arithmetic when the rows size themselves.
	 * Only the window uses it, so a conservative value keeps the cursor inside
	 * the window; rows taller than the estimate scroll in whole rows instead. */
	estimatedItemHeight?: number;
	/** Per-item heights, in item order, for rows that size themselves with
	 * different line counts. Enables an exact window (`ScrollableList`): a list
	 * whose rows vary from two to five lines fills its height instead of
	 * rendering `height / estimate` rows and leaving the rest empty. */
	itemHeights?: number[];
	/** Activation of a row (`Enter`): a tap on the selected row runs it. */
	onActivate?: (index: number) => void;
	/** Whether a row has an activation; defaults to "onActivate is bound". */
	activatable?: (item: T, index: number) => boolean;
	/** Whether the wheel may move this list's cursor (see `ScrollableList`). */
	wheelMovesCursor?: boolean;
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
			{...(props.itemHeights ? { itemHeights: props.itemHeights } : {})}
			// The row inside owns the fill (and the selection surface), so the
			// window wrapper must not paint a second hover layer behind it.
			hoverBackground={false}
			showScrollIndicator={false}
			{...(props.onSelect ? { onSelect: props.onSelect } : {})}
			{...(props.onActivate ? { onActivate: props.onActivate } : {})}
			{...(props.activatable ? { activatable: props.activatable } : {})}
			{...(props.wheelMovesCursor !== undefined
				? { wheelMovesCursor: props.wheelMovesCursor }
				: {})}
			renderItem={(item, isSelected, index) => (
				<Selectable
					height={props.itemHeight}
					selected={isSelected()}
					backgroundColor={props.backgroundColor?.(item, index)}
					hoverBackground={props.hoverBackground}
				>
					{props.renderItem(item, isSelected(), index)}
				</Selectable>
			)}
		/>
	);
}
