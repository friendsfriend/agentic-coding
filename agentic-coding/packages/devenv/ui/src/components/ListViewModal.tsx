/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, type JSX } from "solid-js";
import { uiColors } from "../colors";
import { GenericModal } from "./GenericModal";
import { formatHelpTextLines } from "./HelpText";
import { ScrollableList } from "./ScrollableList";

export interface ListViewModalProps<T> {
	// ── Data ───────────────────────────────────────────────────────────────────
	/** Full (pre-filtered) list of items to display. */
	items: T[];
	/** Currently selected item index within `items`. */
	selectedIndex: number;
	/** When true the loading state is shown instead of the list. */
	loading?: boolean;

	// ── Modal shell ────────────────────────────────────────────────────────────
	title: string;
	helpText: string;
	widthPercent?: number;
	heightPercent?: number;

	// ── Layout budget ──────────────────────────────────────────────────────────
	/**
	 * Lines consumed per item row (default `1`).
	 * Passed through to ScrollableList as `estimatedItemHeight`.
	 */
	estimatedItemHeight?: number;

	/**
	 * Lines consumed by the optional `header` slot above the list.
	 * Only needed when `header` is provided and has fixed known height.
	 * Defaults to `0` (no header reservation).
	 */
	reservedHeight?: number;

	// ── Slots ──────────────────────────────────────────────────────────────────
	/** Rendered above the filter bar and the list. */
	header?: JSX.Element;
	/** Rendered when `items` is empty and `loading` is false. */
	emptyContent?: JSX.Element;
	/** Text shown while loading. Default: `"Loading…"` */
	loadingText?: string;
	/**
	 * Optional noun appended to the item count indicator.
	 * E.g. `"branches"` → `"Showing 1–10 of 20 branches"`.
	 */
	scrollIndicatorLabel?: string;

	// ── Built-in filter bar ────────────────────────────────────────────────────
	/**
	 * Placeholder text shown in the dormant filter bar.
	 * When provided a standard filter bar is always rendered below `header`.
	 */
	filterPlaceholder?: string;
	/** When `true`, the filter `<input>` is rendered and auto-focused. */
	filterActive?: boolean;
	/**
	 * Current filter query string (lives in the caller's store).
	 * Displayed in the dormant bar; pre-populates the active input.
	 */
	filterQuery?: string;
	/**
	 * Called each time the user types in the filter input.
	 */
	onFilterChange?: (query: string) => void;

	// ── Row renderer ───────────────────────────────────────────────────────────
	/**
	 * Called for each visible item.  `isSelected` is a **getter** so that
	 * SolidJS fine-grained reactivity is preserved when `selectedIndex` changes
	 * without `items` changing.
	 *
	 * Usage: `<MyRow isSelected={isSelected()} ... />`
	 */
	renderItem: (
		item: T,
		isSelected: () => boolean,
		absoluteIndex: number,
	) => JSX.Element;
}

/**
 * ListViewModal — modal dialog wrapper around ScrollableList.
 *
 * Combines `GenericModal` (centered overlay with title / help-text footer) with
 * the `ScrollableList` primitive so consumers get virtual scrolling, a filter
 * bar, and a scroll indicator without any boilerplate.
 *
 * All keyboard / navigation logic stays in the caller.
 */
export function ListViewModal<T>(props: ListViewModalProps<T>): JSX.Element {
	const dimensions = useTerminalDimensions();

	const heightPercent = () => Math.max(props.heightPercent ?? 0.9, 0.9);

	/**
	 * Height of the GenericModal dialog box in terminal lines.
	 * Mirrors GenericModal's own computation.
	 */
	const maxDialogHeight = createMemo(() =>
		Math.floor(dimensions().height * heightPercent()),
	);
	const dialogWidth = createMemo(() =>
		Math.floor(dimensions().width * (props.widthPercent ?? 0.5)),
	);
	const helpLineCount = createMemo(
		() =>
			formatHelpTextLines(
				props.helpText
					? props.helpText.split(/\s+•\s+/).map((chunk) => {
							const [key, ...actionParts] = chunk.trim().split(/\s+/);
							return { key: key ?? "", action: actionParts.join(" ") };
						})
					: [],
				Math.max(1, dialogWidth() - 4),
			).length,
	);

	/**
	 * Lines available for ScrollableList content (= everything inside the modal
	 * excluding GenericModal's own chrome).
	 *
	 * GenericModal chrome:
	 *   paddingTop (1) + SearchHeader (1) + FilterStatusBar (1) + paddingBottom (1)
	 *   + wrapped helpText rows (N) = 4 + N
	 *
	 * `props.reservedHeight` covers extra slot content above the list (default 2).
	 */
	const chromeLines = createMemo(
		() =>
			3 + helpLineCount() + (props.header ? (props.reservedHeight ?? 2) : 0),
	);
	const rowLines = createMemo(
		() => props.items.length * (props.estimatedItemHeight ?? 1),
	);
	const maxListLines = createMemo(() =>
		Math.max(1, maxDialogHeight() - chromeLines()),
	);
	const listOverflows = createMemo(
		() =>
			!props.loading && props.items.length > 0 && rowLines() > maxListLines(),
	);
	const desiredListLines = createMemo(() => {
		if (props.loading || props.items.length === 0) return 1;
		return rowLines() + (listOverflows() ? 1 : 0);
	});
	const dialogHeight = createMemo(() =>
		Math.min(maxDialogHeight(), chromeLines() + desiredListLines()),
	);
	const availableLines = createMemo(() =>
		Math.max(1, dialogHeight() - chromeLines()),
	);

	return (
		<GenericModal
			title={props.title}
			helpText={props.helpText}
			widthPercent={props.widthPercent}
			heightLines={dialogHeight()}
			searchMode={props.filterPlaceholder ? props.filterActive : undefined}
			searchQuery={props.filterPlaceholder ? props.filterQuery : undefined}
			searchResultCount={
				props.filterPlaceholder ? props.items.length : undefined
			}
		>
			{/* Optional header slot (rendered above list) */}
			{props.header}

			<ScrollableList<T>
				items={props.items}
				selectedIndex={props.selectedIndex}
				renderItem={(item, isSelected, absoluteIndex) => (
					<box
						backgroundColor={isSelected() ? uiColors.bgSurface0 : undefined}
						style={{ width: "100%", flexDirection: "row", flexShrink: 0 }}
					>
						<box
							backgroundColor={isSelected() ? uiColors.highlight : undefined}
							style={{ width: 2, flexShrink: 0 }}
						/>
						<box style={{ flexGrow: 1, minWidth: 0, overflow: "hidden" }}>
							{props.renderItem(item, isSelected, absoluteIndex)}
						</box>
					</box>
				)}
				availableLines={availableLines()}
				estimatedItemHeight={props.estimatedItemHeight}
				showScrollIndicator={listOverflows()}
				scrollIndicatorLabel={props.scrollIndicatorLabel}
				loading={props.loading}
				loadingText={props.loadingText}
				emptyContent={props.emptyContent}
			/>
		</GenericModal>
	);
}
