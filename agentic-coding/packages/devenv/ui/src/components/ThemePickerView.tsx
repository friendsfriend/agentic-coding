/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, For } from "solid-js";
import { uiColors } from "../colors";
import { themeColorForTheme, themeNames } from "../theme";
import { GenericModal } from "./GenericModal";
import { formatHelpText } from "./HelpText";
import { highlightColor } from "./Highlight";

export interface ThemePickerViewProps {
	selectedIndex: number;
	activeTheme: string;
	filterQuery?: string;
	filterActive?: boolean;
	themes?: string[];
}

const label = (name: string) =>
	name
		.split("-")
		.map((part) => (part ? part[0]?.toUpperCase() + part.slice(1) : part))
		.join(" ");
const nameColumn = (name: string, _selected: boolean, active: boolean) =>
	`${active ? "✓ " : ""}${label(name)}`.padEnd(32).slice(0, 32);

export function ThemePickerView(props: ThemePickerViewProps) {
	const dimensions = useTerminalDimensions();
	const items = () => props.themes ?? themeNames;
	const visibleRows = () =>
		Math.max(1, Math.floor(dimensions().height * 0.75) - 5);
	const visible = createMemo(() => {
		const list = items();
		const rows = visibleRows();
		const maxStart = Math.max(0, list.length - rows);
		const start = Math.max(
			0,
			Math.min(maxStart, props.selectedIndex - Math.floor(rows / 2)),
		);
		return list
			.slice(start, start + rows)
			.map((name, offset) => ({ name, index: start + offset }));
	});
	const showing = () => {
		const list = items();
		if (list.length === 0) return "No themes";
		const first = visible()[0]?.index ?? 0;
		const last = visible()[visible().length - 1]?.index ?? 0;
		return `Showing ${first + 1}-${last + 1} of ${list.length} themes`;
	};

	return (
		<GenericModal
			title="Theme Picker"
			widthPercent={0.7}
			heightPercent={0.75}
			helpText={formatHelpText([
				{ key: "j/k", action: "Navigate" },
				{ key: "/", action: "Filter" },
				{ key: "Enter", action: "Apply" },
				{ key: "Esc", action: "Close" },
			])}
			searchMode={props.filterActive}
			searchQuery={props.filterQuery}
			searchResultCount={items().length}
		>
			<box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
				<For each={visible()}>
					{(item) => {
						const selected = () => item.index === props.selectedIndex;
						const active = () => item.name === props.activeTheme;
						const color = (key: string, fallback: string) =>
							themeColorForTheme(item.name, key, fallback);
						return (
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
									{nameColumn(item.name, selected(), active())}
								</text>
								<text fg={color("primary", uiColors.primary)}> ▬▬▬</text>
								<text fg={color("secondary", uiColors.primaryDim)}>▬▬▬</text>
								<text fg={color("accent", uiColors.accent)}>▬▬▬</text>
								<text fg={color("success", uiColors.success)}>▬▬▬</text>
								<text fg={color("warning", uiColors.warning)}>▬▬▬</text>
								<text fg={color("error", uiColors.error)}>▬▬▬</text>
							</box>
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
