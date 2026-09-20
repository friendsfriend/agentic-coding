/** @jsxImportSource @opentui/solid */
// Modal list — a dialog around the windowed `ScrollableList`, one implementation
// for the env surface and the dashboard.
//
// Two behaviours are explicit rather than implied:
//
// - `sizing: "content"` (default, env pickers): the dialog grows with the list,
//   capped at `heightPercent`.
// - `sizing: "cap"` (dashboard dialogs): the dialog is exactly `heightPercent`
//   and the list windows inside it.
//
// Help is accepted as entries (the dashboard's shape) or as a pre-formatted
// string (the env's), and `renderItem` gets a selection *getter* so a cursor
// move does not re-render the whole list.
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, type JSX } from "solid-js";
import { uiColors } from "../theme/colors";
import type { SummaryEntry } from "./GenericModal.tsx";
import { GenericModal } from "./GenericModal.tsx";
import { formatHelpTextLines, wrapHelpEntries } from "./HelpText.tsx";
import type { Keybind, KeybindSection } from "./keybinds.ts";
import { ScrollableList } from "./ScrollableList.tsx";

export type ListViewModalSizing = "content" | "cap";

export interface ListViewModalProps<T> {
	items: T[];
	selectedIndex: number;
	loading?: boolean;

	// ── Dialog shell ───────────────────────────────────────────────────────────
	title: string;
	/** Pre-formatted help footer (env surface). */
	helpText?: string;
	/** Keybind entries (dashboard), wrapped into the same footer. */
	help?: readonly Keybind[];
	helpSections?: KeybindSection[] | false;
	widthPercent?: number;
	heightPercent?: number;
	fieldLabel?: string;
	summary?: SummaryEntry[];
	step?: number;
	total?: number;
	/** Display-only `/ <query>` header (legacy dash search). */
	search?: string;
	/** Default `"content"`. */
	sizing?: ListViewModalSizing;

	// ── Layout budget ──────────────────────────────────────────────────────────
	estimatedItemHeight?: number;
	/** Alias for `estimatedItemHeight`, the dashboard's name for it. */
	itemHeight?: number;
	reservedHeight?: number;

	// ── Slots ──────────────────────────────────────────────────────────────────
	header?: JSX.Element;
	emptyContent?: JSX.Element;
	loadingText?: string;
	scrollIndicatorLabel?: string;

	// ── Filter bar ─────────────────────────────────────────────────────────────
	filterPlaceholder?: string;
	filterActive?: boolean;
	filterQuery?: string;
	onFilterChange?: (query: string) => void;

	renderItem: (
		item: T,
		isSelected: () => boolean,
		absoluteIndex: number,
	) => JSX.Element;
}

export function ListViewModal<T>(props: ListViewModalProps<T>): JSX.Element {
	const dimensions = useTerminalDimensions();
	const sizing = () => props.sizing ?? "content";
	const heightPercent = () => Math.max(props.heightPercent ?? 0.9, 0.9);
	const itemHeight = () => props.estimatedItemHeight ?? props.itemHeight ?? 1;

	/** Dialog height in lines, mirroring `GenericModal`'s own computation. */
	const maxDialogHeight = createMemo(() =>
		Math.floor(dimensions().height * heightPercent()),
	);
	const dialogWidth = createMemo(() =>
		Math.floor(dimensions().width * (props.widthPercent ?? 0.5)),
	);
	/** Footer rows, from whichever help shape the caller used. */
	const helpLineCount = createMemo(() => {
		const width = Math.max(1, dialogWidth() - 4);
		if (props.helpText !== undefined) {
			return formatHelpTextLines(
				props.helpText
					? props.helpText.split(/\s+•\s+/).map((chunk) => {
							const [key, ...action] = chunk.trim().split(/\s+/);
							return { key: key ?? "", action: action.join(" ") };
						})
					: [],
				width,
			).length;
		}
		const entries = props.help ?? [];
		return entries.length ? wrapHelpEntries(entries, width).length : 1;
	});

	/**
	 * Dialog chrome around the list: padding top/bottom (2), the header row (1),
	 * the wrapped help footer (N) and an optional caller slot.
	 */
	const chromeLines = createMemo(
		() =>
			3 + helpLineCount() + (props.header ? (props.reservedHeight ?? 2) : 0),
	);
	const rowLines = createMemo(() => props.items.length * itemHeight());
	const maxListLines = createMemo(() =>
		Math.max(1, maxDialogHeight() - chromeLines()),
	);
	const listOverflows = createMemo(
		() =>
			!props.loading && props.items.length > 0 && rowLines() > maxListLines(),
	);
	/** "content" grows the dialog with the list; "cap" always fills it. */
	const desiredListLines = createMemo(() => {
		if (sizing() === "cap") return maxListLines();
		if (props.loading || props.items.length === 0) return 1;
		return Math.min(maxListLines(), rowLines()) + (listOverflows() ? 1 : 0);
	});
	const dialogHeight = createMemo(() =>
		sizing() === "cap"
			? maxDialogHeight()
			: Math.min(maxDialogHeight(), chromeLines() + desiredListLines()),
	);
	const availableLines = createMemo(() =>
		Math.max(1, dialogHeight() - chromeLines()),
	);

	return (
		<GenericModal
			title={props.title}
			{...(props.helpText !== undefined ? { helpText: props.helpText } : {})}
			{...(props.help !== undefined ? { help: props.help } : {})}
			{...(props.helpSections !== undefined
				? { helpSections: props.helpSections }
				: {})}
			{...(props.fieldLabel !== undefined
				? { fieldLabel: props.fieldLabel }
				: {})}
			{...(props.summary !== undefined ? { summary: props.summary } : {})}
			{...(props.step !== undefined ? { step: props.step } : {})}
			{...(props.total !== undefined ? { total: props.total } : {})}
			widthPercent={props.widthPercent}
			heightLines={dialogHeight()}
			{...(props.search !== undefined ? { search: props.search } : {})}
			searchMode={props.filterPlaceholder ? props.filterActive : undefined}
			searchQuery={
				props.filterPlaceholder
					? (props.filterQuery ?? props.search)
					: props.search
			}
			searchResultCount={
				props.filterPlaceholder ? props.items.length : undefined
			}
		>
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
				estimatedItemHeight={itemHeight()}
				showScrollIndicator={listOverflows()}
				{...(props.scrollIndicatorLabel !== undefined
					? { scrollIndicatorLabel: props.scrollIndicatorLabel }
					: {})}
				{...(props.loading !== undefined ? { loading: props.loading } : {})}
				{...(props.loadingText !== undefined
					? { loadingText: props.loadingText }
					: {})}
				{...(props.emptyContent !== undefined
					? { emptyContent: props.emptyContent }
					: {})}
			/>
		</GenericModal>
	);
}
