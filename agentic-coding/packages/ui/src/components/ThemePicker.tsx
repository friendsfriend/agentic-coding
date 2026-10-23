/** @jsxImportSource @opentui/solid */

import { createMemo, For, type JSX } from "solid-js";
import { useTerminalDimensions } from "../hooks/useTerminalDimensions.ts";
import { uiColors } from "../theme/colors";
import { themeColorForTheme, themeNames } from "../theme/theme";
import { GenericModal } from "./GenericModal.tsx";
import { formatHelpText } from "./HelpText.tsx";
import { highlightColor } from "./Highlight.tsx";
import { useHover } from "./mouse/useHover.ts";
import { useKeyDispatch } from "./mouse/useKeybindChips.ts";
import { useRowMouse } from "./mouse/useRowMouse.ts";

/** A prop that may be a plain value or a Solid accessor. */
export type Readable<T> = T | (() => T);

function read<T>(value: Readable<T>): T {
	return typeof value === "function" ? (value as () => T)() : value;
}

export interface ThemePickerProps {
	/** Index of the highlighted row. */
	selected: Readable<number>;
	/** Currently active (applied) theme name. */
	active: Readable<string>;
	/** Theme names to list; defaults to the shared registry. */
	themes?: Readable<string[]>;
	/** Current filter query. */
	query?: Readable<string>;
	/** Whether the filter input is active. */
	filtering?: Readable<boolean>;
	/**
	 * `live` renders the filtered query with the live `█` cursor (environment
	 * contract); `display` renders the legacy display-only `/ <query>` header.
	 */
	searchMode?: "live" | "display";
	/** Advertise the `/` filter keybind in the footer and `?` help catalog. */
	showFilterKeybind?: boolean;
	/** Pointer: a tap selects a row (the keyboard's `j`/`k`/`↑`/`↓`). */
	onSelect?: (index: number) => void;
}

/**
 * One theme row: a tap selects it, a tap on the selected row applies it (the
 * picker's own `Enter`), and a drag or a non-primary button does nothing.
 */
function ThemeRow(props: {
	index: number;
	selectedIndex: () => number;
	onSelect?: (index: number) => void;
	children: JSX.Element;
}) {
	const dispatch = useKeyDispatch();
	const mouse = useRowMouse({
		index: props.index,
		selectedIndex: props.selectedIndex,
		activatable: () => props.onSelect !== undefined,
		onSelect: (index) => props.onSelect?.(index),
		onActivate: (index) => {
			props.onSelect?.(index);
			dispatch("Enter");
		},
	});
	const hover = useHover(mouse.onMouseOut);
	const interactive = () => props.onSelect !== undefined;
	return (
		<box
			{...mouse}
			{...hover}
			backgroundColor={
				interactive() && hover.hovered() ? uiColors.bgHover : undefined
			}
			style={{ flexDirection: "row", width: "100%" }}
		>
			{props.children}
		</box>
	);
}

const label = (name: string) =>
	name
		.split("-")
		.map((part) =>
			part ? (part[0]?.toUpperCase() ?? "") + part.slice(1) : part,
		)
		.join(" ");

/**
 * One theme picker for every surface. The environment shell, dashboard and
 * observability render this through thin prop adapters; the shared theme store
 * (`theme.ts`) drives the list and the per-theme swatches.
 */
export function ThemePicker(props: ThemePickerProps) {
	const dimensions = useTerminalDimensions();
	/** Dialog content width is `0.7 * terminal - 4`; reserve the swatch cells. */
	const nameWidth = () =>
		Math.max(12, Math.min(32, Math.floor(dimensions().width * 0.7) - 4 - 19));
	const items = () => read(props.themes ?? themeNames);
	const selectedIndex = () => read(props.selected);
	const activeTheme = () => read(props.active);
	const filtering = () => (props.filtering ? read(props.filtering) : false);
	const query = () => (props.query ? read(props.query) : "");
	const visibleRows = () =>
		Math.max(1, Math.floor(dimensions().height * 0.75) - 5);
	const visible = createMemo(() => {
		const list = items();
		const rows = visibleRows();
		const maxStart = Math.max(0, list.length - rows);
		const start = Math.max(
			0,
			Math.min(maxStart, selectedIndex() - Math.floor(rows / 2)),
		);
		return list
			.slice(start, start + rows)
			.map((name, offset) => ({ name, index: start + offset }));
	});
	const showing = () => {
		const list = items();
		if (list.length === 0) return "No themes";
		const windowed = visible();
		const first = windowed[0]?.index ?? 0;
		const last = windowed[windowed.length - 1]?.index ?? 0;
		return `Showing ${first + 1}-${last + 1} of ${list.length} themes`;
	};
	const nameColumn = (name: string, active: boolean) =>
		`${active ? "✓ " : "  "}${label(name)}`
			.slice(0, nameWidth())
			.padEnd(nameWidth());

	return (
		<GenericModal
			title="Theme Picker"
			widthPercent={0.7}
			heightPercent={0.75}
			helpText={
				props.searchMode === "live"
					? formatHelpText([
							{ key: "j/k", action: "Navigate" },
							...(props.showFilterKeybind === false
								? []
								: [{ key: "/", action: "Filter" }]),
							{ key: "Enter", action: "Apply" },
							{ key: "Esc", action: "Close" },
						])
					: undefined
			}
			help={
				props.searchMode === "live"
					? undefined
					: [
							{ key: "j/k", action: "Navigate" },
							...(props.showFilterKeybind
								? [{ key: "/", action: "Filter" }]
								: []),
							{ key: "Enter", action: "Apply" },
							{ key: "Esc", action: "Close" },
						]
			}
			searchMode={props.searchMode === "live" ? filtering() : undefined}
			searchQuery={props.searchMode === "live" ? query() : undefined}
			searchResultCount={
				props.searchMode === "live" ? items().length : undefined
			}
			search={props.searchMode === "live" || !filtering() ? undefined : query()}
		>
			<box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
				<For each={visible()}>
					{(item) => {
						const selected = () => item.index === selectedIndex();
						const active = () => item.name === activeTheme();
						const color = (key: string, fallback: string) =>
							themeColorForTheme(item.name, key, fallback);
						return (
							<ThemeRow
								index={item.index}
								selectedIndex={selectedIndex}
								{...(props.onSelect ? { onSelect: props.onSelect } : {})}
							>
								<box
									style={{
										flexDirection: "row",
										width: "100%",
										height: 1,
										backgroundColor: selected()
											? uiColors.selectionBgActive
											: undefined,
									}}
								>
									<text
										fg={
											selected() ? uiColors.selectionText : uiColors.textPrimary
										}
									>
										{nameColumn(item.name, active())}
									</text>
									<text fg={color("primary", uiColors.primary)}> ▬▬▬</text>
									<text fg={color("secondary", uiColors.primaryDim)}>▬▬▬</text>
									<text fg={color("accent", uiColors.accent)}>▬▬▬</text>
									<text fg={color("success", uiColors.success)}>▬▬▬</text>
									<text fg={color("warning", uiColors.warning)}>▬▬▬</text>
									<text fg={color("error", uiColors.error)}>▬▬▬</text>
								</box>
							</ThemeRow>
						);
					}}
				</For>
				<box style={{ width: "100%", height: 1, flexDirection: "row" }}>
					<text fg={highlightColor("secondary")}>{showing()}</text>
				</box>
			</box>
		</GenericModal>
	);
}
