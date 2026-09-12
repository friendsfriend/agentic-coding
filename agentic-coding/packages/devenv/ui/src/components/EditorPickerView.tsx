/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { uiColors } from "../colors";
import { formatHelpText } from "./HelpText";
import { highlightColor } from "./Highlight";
import { ListViewModal } from "./ListViewModal";

export type EditorChoice = "nvim" | "vscode" | "intellij";

export interface EditorOption {
	id: EditorChoice;
	label: string;
	description: string;
}

export const EDITOR_OPTIONS: EditorOption[] = [
	{ id: "nvim", label: "Neovim", description: "Open in Neovim (terminal)" },
	{ id: "vscode", label: "VS Code", description: "Open in Visual Studio Code" },
	{
		id: "intellij",
		label: "IntelliJ IDEA",
		description: "Open in IntelliJ IDEA",
	},
];

export interface EditorPickerViewProps {
	selectedIndex: number;
	options: EditorOption[];
}

function EditorRow(props: { option: EditorOption; isSelected: boolean }) {
	return (
		<box
			backgroundColor={props.isSelected ? uiColors.bgSurface0 : undefined}
			style={{
				width: "100%",
				height: 1,
				paddingLeft: 1,
				paddingRight: 1,
				flexDirection: "row",
			}}
		>
			<text
				fg={props.isSelected ? uiColors.primary : uiColors.textPrimary}
				attributes={props.isSelected ? TextAttributes.BOLD : undefined}
			>
				{props.option.label}
			</text>
			<text fg={highlightColor("secondary")}>
				{"  "}
				{props.option.description}
			</text>
		</box>
	);
}

export function EditorPickerView(props: EditorPickerViewProps) {
	return (
		<ListViewModal
			title="Open in Editor"
			helpText={formatHelpText([
				{ key: "j/k", action: "Navigate" },
				{ key: "Enter", action: "Open" },
				{ key: "Esc", action: "Cancel" },
			])}
			widthPercent={0.4}
			heightPercent={0.3}
			items={props.options}
			selectedIndex={props.selectedIndex}
			scrollIndicatorLabel="editors"
			renderItem={(option, isSelected) => (
				<EditorRow option={option} isSelected={isSelected()} />
			)}
		/>
	);
}
