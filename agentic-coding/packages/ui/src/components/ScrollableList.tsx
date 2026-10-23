/** @jsxImportSource @opentui/solid */

import { createMemo, For, type JSX, Show } from "solid-js";
import { useTerminalDimensions } from "../hooks/useTerminalDimensions.ts";
import { uiColors } from "../theme/colors";
import { AnimatedStatusText } from "./AnimatedStatusText.tsx";
import { useModalContentLines } from "./GenericModal.tsx";
import { moveRowIndex } from "./mouse/clickSemantics.ts";
import { useHover } from "./mouse/useHover.ts";
import { type RowGestureState, useRowMouse } from "./mouse/useRowMouse.ts";
import { useWheelScroll } from "./mouse/useWheelScroll.ts";
import { focusSoon } from "./utils/focusSoon.ts";
import { calculateVisibleItems } from "./utils/virtualScroll.ts";

// ─── Layout constants ────────────────────────────────────────────────────────

/**
 * Lines consumed by the top-level <Layout> wrapper (header: 3 + footer: 3).
 * Import this constant when computing `reservedLines` for any full-screen view
 * that is rendered inside <Layout>.
 *
 * @see packages/ui/src/components/Layout.tsx
 */
export const LAYOUT_CHROME_LINES = 5;

// ─── Internal constants ───────────────────────────────────────────────────────

/** Lines consumed by the built-in filter bar (input row + marginBottom). */
const FILTER_BAR_LINES = 2;

/** Lines consumed by the scroll indicator (indicator row + marginTop). */
const SCROLL_INDICATOR_LINES = 2;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScrollableListProps<T> {
	// ── Data ───────────────────────────────────────────────────────────────────
	/** Pre-filtered list of items to render. */
	items: T[];

	/** Currently selected item index within `items`. */
	selectedIndex: number;

	/**
	 * Row renderer.  `isSelected` is a **getter** (not a plain boolean) so
	 * SolidJS fine-grained reactivity is preserved when only `selectedIndex`
	 * changes without `items` changing.
	 *
	 * Usage inside renderItem:
	 * ```tsx
	 * <MyRow selected={isSelected()} item={item} />
	 * ```
	 */
	renderItem: (
		item: T,
		isSelected: () => boolean,
		absoluteIndex: number,
	) => JSX.Element;

	// ── Height budget ───────────────────────────────────────────────────────────
	/**
	 * Lines of **all** fixed chrome that lie outside this component and eat into
	 * the available terminal height.  Include every fixed-height element that is
	 * on screen at the same time as this list:
	 *
	 * | Source                          | Lines |
	 * |---------------------------------|-------|
	 * | Layout header                   |   3   |
	 * | Layout footer                   |   3   |
	 * | Component outer rounded border  |   2   |
	 * | Component title / stats rows    |   N   |
	 * | Tab bar (if present)            |   3   |
	 * | Table / column header row       |   1   |
	 *
	 * Use the exported `LAYOUT_CHROME_LINES` (= 5) constant for the Layout pair.
	 *
	 * The component automatically reserves additional lines for its **own**
	 * internal chrome (filter bar, scroll indicator) — do NOT include those here.
	 *
	 * Mutually exclusive with `availableLines`.  When both are provided,
	 * `availableLines` takes precedence.
	 *
	 * @example
	 * // Full-screen view inside Layout with rounded border, 2-row title, and 1-row table header:
	 * reservedLines={LAYOUT_CHROME_LINES + 2 + 2 + 1}  // = 10
	 */
	reservedLines?: number;

	/**
	 * Directly specifies the number of lines available for the scrollable list
	 * area **before** subtracting the filter bar and scroll indicator (which are
	 * handled automatically).
	 *
	 * Use this inside modal dialogs where the available height is
	 * `dialogHeight − modalChrome` rather than `terminalHeight − reservedLines`.
	 *
	 * Mutually exclusive with `reservedLines`.
	 */
	availableLines?: number;

	// ── Item sizing ─────────────────────────────────────────────────────────────
	/**
	 * Uniform row height in terminal lines (default: `1`).
	 * Ignored when `itemHeights` is provided.
	 */
	estimatedItemHeight?: number;

	/**
	 * Per-item heights array whose length **must** equal `items.length`.
	 * Enables accurate virtual scrolling for variable-height rows such as
	 * discussion threads.  When provided, `estimatedItemHeight` is ignored.
	 */
	itemHeights?: number[];

	// ── Scroll indicator ────────────────────────────────────────────────────────
	/**
	 * Show a "Showing X–Y of N [label]" line below the list.
	 * Defaults to `true` whenever `items.length > 0`.
	 */
	showScrollIndicator?: boolean;

	/**
	 * Noun appended to the scroll indicator.
	 * E.g. `"branches"` → `"Showing 1–10 of 20 branches"`.
	 */
	scrollIndicatorLabel?: string;

	// ── Scrollbar ────────────────────────────────────────────────────────────────
	/**
	 * Show a vertical scrollbar on the right edge of the list.
	 * Only rendered when the item count exceeds the visible window.
	 * Default: `true`.
	 */
	showScrollbar?: boolean;

	// ── Empty state ─────────────────────────────────────────────────────────────
	/**
	 * Content rendered centred in the available space when `items` is empty and
	 * `loading` is false.  Defaults to a plain `"No items"` message.
	 */
	emptyContent?: JSX.Element;

	// ── Loading state ───────────────────────────────────────────────────────────
	/** When true, shows the loading indicator instead of the list. */
	loading?: boolean;

	/** Text shown while loading.  Default: `"Loading…"` */
	loadingText?: string;

	// ── Built-in filter bar ─────────────────────────────────────────────────────
	/**
	 * Placeholder text for the filter input.
	 * When provided, a standard filter bar is rendered above the list.
	 * Keyboard activation (e.g. pressing `/`) is handled by the caller.
	 */
	filterPlaceholder?: string;

	/**
	 * When `true`, the filter `<input>` is rendered and auto-focused.
	 * When `false` (or absent), a dormant hint line is shown instead.
	 */
	filterActive?: boolean;

	/**
	 * Current filter query string (lives in the caller's store).
	 * Displayed in the dormant filter bar; pre-populates the active `<input>`.
	 */
	filterQuery?: string;

	/** Called each time the user types in the active filter input. */
	onFilterChange?: (query: string) => void;

	/** Called when mouse wheel/trackpad scrolls over the list rows. */
	onScroll?: (
		direction: "up" | "down" | "left" | "right",
		delta: number,
	) => void;

	// ── Pointer (shared mouse layer) ───────────────────────────────────────────
	/**
	 * Select a row on a tap (the keyboard's `j`/`k`). When neither `onSelect`
	 * nor `onActivate` is given, the rows carry no pointer handler at all: the
	 * wheel then bubbles to an outer scroll owner instead of being swallowed by
	 * a list that cannot scroll itself.
	 */
	onSelect?: (index: number) => void;
	/** Activate the tapped row (the keyboard's `Enter`). */
	onActivate?: (index: number) => void;
	/** Whether a row has an activation; defaults to "onActivate is bound". */
	activatable?: (item: T, index: number) => boolean;
	/**
	 * Whether the wheel may move this list's cursor. Default true, which is what
	 * `j`/`k` do. Set it false on a list whose *selection* triggers I/O (the
	 * evidence preview): the wheel then leaves the pane inert instead of issuing
	 * a read per wheel event (`tui-input-responsiveness`).
	 */
	wheelMovesCursor?: boolean;
	/**
	 * Surface under an interactive row while the pointer is over it. Only used
	 * when the list carries a row gesture; defaults to the shared hover lift.
	 * `false` keeps the rows static, and a list that paints its own row surface
	 * can opt out because that surface owns the fill.
	 */
	hoverBackground?: string | false;
}

/**
 * ScrollableList — universal virtual-scroll list primitive.
 *
 * ## What it does
 * - Keeps the selected item always in view (virtual windowing via `calculateVisibleItems`)
 * - Supports uniform-height rows (`estimatedItemHeight`) and variable-height rows (`itemHeights`)
 * - Never overflows its container (`overflow: hidden` on the rows box)
 * - Shows a "Showing X–Y of N" scroll indicator
 * - Loading and empty states
 * - Built-in activatable filter bar (same pattern as `ListViewModal`)
 *
 * ## Height calculation
 * The component needs to know how many lines it has available.  Supply either:
 * - `reservedLines` — total fixed chrome **outside** this component (Layout header/footer,
 *   component borders, title rows, tab bars…).  The component computes
 *   `availableLines = terminalHeight − reservedLines` and then subtracts its own
 *   internal chrome (filter bar, scroll indicator).
 * - `availableLines` — directly specify the content area height (for modal dialogs
 *   where the available height is `dialogHeight − modalChrome`).
 *
 * ## Usage
 *
 * ### Full-screen view inside Layout with a border and a 2-row title section:
 * ```tsx
 * <ScrollableList
 *   items={files}
 *   selectedIndex={selectedIndex()}
 *   renderItem={(file, isSelected) => <FileRow file={file} selected={isSelected()} />}
 *   reservedLines={LAYOUT_CHROME_LINES + 2 + 2 + 1}  // layout(5) + border(2) + title(2) + tableHeader(1)
 *   scrollIndicatorLabel="files"
 * />
 * ```
 *
 * ### Inside a GenericModal dialog:
 * ```tsx
 * <ScrollableList
 *   items={branches}
 *   selectedIndex={branchIndex()}
 *   renderItem={...}
 *   availableLines={dialogContentHeight}
 *   scrollIndicatorLabel="branches"
 * />
 * ```
 *
 * ### Variable-height rows (e.g. discussion threads):
 * ```tsx
 * const heights = createMemo(() => items.map(d => d.isSystem ? 2 : 4));
 * <ScrollableList
 *   items={discussions()}
 *   selectedIndex={selectedIndex()}
 *   renderItem={renderDiscussion}
 *   itemHeights={heights()}
 *   reservedLines={LAYOUT_CHROME_LINES + 2 + 2}
 * />
 * ```
 */
export function ScrollableList<T>(props: ScrollableListProps<T>): JSX.Element {
	const dimensions = useTerminalDimensions();
	const hasFilterBar = () => !!props.filterPlaceholder;
	const showIndicator = () =>
		props.showScrollIndicator !== false && props.items.length > 0;

	/**
	 * Lines available for actual list rows, after subtracting outer chrome
	 * (via reservedLines / availableLines) and internal chrome (filter bar +
	 * scroll indicator).
	 */
	// Inside a dialog the dialog knows the budget; a full-page list passes its own
	// (`availableLines`) or reserves the host chrome (`reservedLines`).
	const modalLines = useModalContentLines();
	const budgetLines = () =>
		props.availableLines ??
		modalLines?.() ??
		Math.max(1, dimensions().height - (props.reservedLines ?? 0));

	const listAreaLines = createMemo(() => {
		const filterLines = hasFilterBar() ? FILTER_BAR_LINES : 0;
		const indicatorLines = showIndicator() ? SCROLL_INDICATOR_LINES : 0;
		return Math.max(1, budgetLines() - filterLines - indicatorLines);
	});

	const maxVisibleUniformItems = createMemo(() =>
		Math.max(1, Math.floor(listAreaLines() / (props.estimatedItemHeight ?? 1))),
	);

	const uniformWindowStart = createMemo(() => {
		if (props.items.length === 0 || props.itemHeights) return 0;
		const maxVisible = maxVisibleUniformItems();
		const clampedSelected = Math.max(
			0,
			Math.min(props.selectedIndex, props.items.length - 1),
		);
		const pageStart = Math.floor(clampedSelected / maxVisible) * maxVisible;
		return Math.max(
			0,
			Math.min(pageStart, Math.max(0, props.items.length - maxVisible)),
		);
	});

	/** Virtual window: only the items that fit on screen around the selection. */
	const visibleItems = createMemo(() => {
		if (props.items.length === 0) return [];

		// Hot path for uniform-height lists (tables, issues, CRs): depend on the
		// page window, not the exact selected index, so holding j/k only updates
		// selection styling and does not recreate every visible row.
		if (!props.itemHeights) {
			const startIdx = uniformWindowStart();
			const endIdx = Math.min(
				props.items.length,
				startIdx + maxVisibleUniformItems(),
			);
			return props.items.slice(startIdx, endIdx).map((item, idx) => ({
				item,
				absoluteIndex: startIdx + idx,
			}));
		}

		const result = calculateVisibleItems(props.items, {
			totalItems: props.items.length,
			selectedIndex: props.selectedIndex,
			visibleHeight: listAreaLines(),
			estimatedItemHeight: props.estimatedItemHeight ?? 1,
			itemHeights: props.itemHeights,
		});
		return result.visibleItems;
	});

	/** True only when items overflow the visible window — drives scrollbar visibility. */
	const needsScrollbar = () =>
		props.showScrollbar !== false &&
		props.items.length > 0 &&
		visibleItems().length < props.items.length;

	/**
	 * Top offset of the scrollbar thumb in terminal lines.
	 * Proportional to how far into the list the visible window starts.
	 */
	const thumbTop = createMemo(() => {
		const total = props.items.length;
		const startIdx = visibleItems()[0]?.absoluteIndex ?? 0;
		return Math.floor((listAreaLines() * startIdx) / total);
	});

	/**
	 * Height of the scrollbar thumb in terminal lines (minimum 1).
	 * Proportional to the fraction of items currently visible.
	 */
	const thumbHeight = createMemo(() => {
		const total = props.items.length;
		const visible = visibleItems().length;
		return Math.max(1, Math.ceil((listAreaLines() * visible) / total));
	});

	/**
	 * One gesture holder per list: a windowed list recreates its row instances when
	 * the window moves, so a press must not belong to a row instance that a
	 * recompute can discard mid-gesture (design D3/D4).
	 */
	const canMouseRows = () =>
		props.onSelect !== undefined || props.onActivate !== undefined;
	const gesture: RowGestureState = {};

	/**
	 * The wheel scrolls the pane under the pointer, not the focused one: an
	 * explicit `onScroll` wins, otherwise a list whose keyboard scroll moves the
	 * cursor moves it here too (design D7).
	 */
	const wheel = useWheelScroll({
		// The pane only swallows the wheel when it can actually act; otherwise the
		// event bubbles to an enclosing scroll owner.
		enabled: () =>
			props.onScroll !== undefined ||
			(props.wheelMovesCursor !== false &&
				props.onSelect !== undefined &&
				props.items.length > 0),
		onScroll: (direction, delta) => {
			if (props.onScroll) {
				props.onScroll(direction, delta);
				return;
			}
			// A list whose selection triggers I/O keeps the wheel off its cursor.
			if (props.wheelMovesCursor === false) return;
			if (!props.onSelect) return;
			const count = props.items.length;
			if (count === 0) return;
			const next = moveRowIndex(props.selectedIndex, direction, delta, count);
			if (next !== props.selectedIndex) props.onSelect(next);
		},
	});

	return (
		<>
			{/* ── Filter bar ──────────────────────────────────────────────────────── */}
			<Show when={hasFilterBar()}>
				<Show
					when={props.filterActive}
					fallback={
						/* Dormant: show "/" hint and the active query (or placeholder) */
						<box
							style={{
								width: "100%",
								height: 1,
								flexDirection: "row",
								flexShrink: 0,
								marginBottom: 1,
							}}
						>
							<text fg={uiColors.textMuted}>{"/ "}</text>
							<Show
								when={props.filterQuery}
								fallback={
									<text fg={uiColors.textMuted}>{props.filterPlaceholder}</text>
								}
							>
								<text fg={uiColors.textPrimary}>{props.filterQuery}</text>
							</Show>
						</box>
					}
				>
					{/* Active: auto-focused <input> element */}
					<box
						style={{
							width: "100%",
							height: 1,
							flexDirection: "row",
							flexShrink: 0,
							marginBottom: 1,
						}}
					>
						<text fg={uiColors.textMuted}>{"/ "}</text>
						<input
							ref={(el) => {
								focusSoon(el);
							}}
							onInput={(val: string) => props.onFilterChange?.(val)}
							placeholder={props.filterPlaceholder}
							style={{ flexGrow: 1 }}
							focusedBackgroundColor={uiColors.bgBase}
							focusedTextColor={uiColors.textPrimary}
						/>
					</box>
				</Show>
			</Show>

			{/* ── Main content ────────────────────────────────────────────────────── */}
			<Show
				when={!props.loading}
				fallback={
					<box
						style={{
							width: "100%",
							flexGrow: 1,
							justifyContent: "center",
							alignItems: "center",
						}}
					>
						<AnimatedStatusText
							text={props.loadingText ?? "Loading…"}
							intent="load"
							backgroundColor={uiColors.bgMantle}
						/>
					</box>
				}
			>
				<Show
					when={props.items.length > 0}
					fallback={
						<box
							style={{
								width: "100%",
								flexGrow: 1,
								justifyContent: "center",
								alignItems: "center",
								flexDirection: "column",
								gap: 1,
							}}
						>
							{props.emptyContent ?? (
								<text fg={uiColors.textMuted}>No items</text>
							)}
						</box>
					}
				>
					{/*
					 * Outer row: list content + optional scrollbar side by side.
					 * The scrollbar is 1 char wide and only rendered when items overflow.
					 */}
					<box
						{...wheel}
						style={{
							width: "100%",
							height: listAreaLines(),
							flexGrow: 0,
							flexShrink: 0,
							minHeight: 0,
							flexDirection: "row",
							overflow: "hidden",
						}}
					>
						{/* List rows — overflow: hidden prevents rounding leaks */}
						<box
							style={{
								flexGrow: 1,
								flexShrink: 1,
								minHeight: 0,
								flexDirection: "column",
								overflow: "hidden",
							}}
						>
							<For each={visibleItems()}>
								{(visibleItem) => {
									const isSelected = () =>
										visibleItem.absoluteIndex === props.selectedIndex;
									const row = () =>
										props.renderItem(
											visibleItem.item,
											isSelected,
											visibleItem.absoluteIndex,
										);
									if (!canMouseRows()) return row();
									// The renderer hands the row its absolute index, so a scrolled
									// window selects the row the developer sees (design D4).
									const mouse = useRowMouse({
										gesture,
										index: visibleItem.absoluteIndex,
										selectedIndex: () => props.selectedIndex,
										activatable: () =>
											props.activatable
												? props.activatable(
														visibleItem.item,
														visibleItem.absoluteIndex,
													)
												: props.onActivate !== undefined,
										onSelect: (index) => props.onSelect?.(index),
										onActivate: (index) => props.onActivate?.(index),
									});
									const hover = useHover(mouse.onMouseOut);
									const hoverBackground = () =>
										props.hoverBackground === false
											? undefined
											: (props.hoverBackground ?? uiColors.bgHover);
									return (
										<box
											{...mouse}
											{...hover}
											backgroundColor={
												!isSelected() && hover.hovered()
													? hoverBackground()
													: undefined
											}
											style={{
												width: "100%",
												flexShrink: 0,
												flexDirection: "column",
											}}
										>
											{row()}
										</box>
									);
								}}
							</For>
						</box>

						{/* Scrollbar (1 char wide, thumb + track) */}
						<Show when={needsScrollbar()}>
							<box
								style={{
									width: 1,
									flexShrink: 0,
									flexDirection: "column",
									minHeight: 0,
									overflow: "hidden",
								}}
							>
								{/* Track above thumb */}
								<Show when={thumbTop() > 0}>
									<box
										style={{ width: 1, height: thumbTop(), flexShrink: 0 }}
										backgroundColor={uiColors.scrollbarTrack}
									/>
								</Show>
								{/* Thumb */}
								<box
									style={{ width: 1, height: thumbHeight(), flexShrink: 0 }}
									backgroundColor={uiColors.scrollbarThumb}
								/>
								{/* Track below thumb - flexGrow with minHeight:0 so it collapses to 0 at end-of-scroll */}
								<box
									style={{ width: 1, flexGrow: 1, minHeight: 0 }}
									backgroundColor={uiColors.scrollbarTrack}
								/>
							</box>
						</Show>
					</box>

					{/* ── Scroll indicator ──────────────────────────────────────────── */}
					<Show when={showIndicator()}>
						<box
							style={{
								width: "100%",
								height: 1,
								justifyContent: "center",
								flexShrink: 0,
							}}
						>
							<text fg={uiColors.textMuted}>
								Showing {(visibleItems()[0]?.absoluteIndex ?? 0) + 1}–
								{(visibleItems()[visibleItems().length - 1]?.absoluteIndex ??
									0) + 1}{" "}
								of {props.items.length}
								{props.scrollIndicatorLabel
									? ` ${props.scrollIndicatorLabel}`
									: ""}
							</text>
						</box>
					</Show>
				</Show>
			</Show>
		</>
	);
}
