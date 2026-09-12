/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { uiColors } from "../colors";
import { formatHelpText } from "./HelpText";
import { ListViewModal } from "./ListViewModal";

export interface LabelPickerModalProps {
	labels: string[];
	selectedLabels: string[];
	selectedIndex: number;
	loading: boolean;
	onSelect: (index: number) => void;
	onToggle: (label: string) => void;
	onConfirm: () => void;
	onCancel: () => void;
}

function LabelRow(props: {
	label: string;
	isSelected: boolean;
	isToggled: boolean;
}) {
	const checkbox = () => (props.isToggled ? "☑ " : "☐ ");

	return (
		<box
			backgroundColor={props.isSelected ? uiColors.bgSurface0 : undefined}
			style={{
				width: "100%",
				height: 1,
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<text
				fg={uiColors.textPrimary}
				attributes={props.isSelected ? TextAttributes.BOLD : undefined}
			>
				{checkbox()}
				{props.label}
			</text>
		</box>
	);
}

export function LabelPickerModal(props: LabelPickerModalProps) {
	const isToggled = (label: string) => props.selectedLabels.includes(label);

	return (
		<Show
			when={props.loading}
			fallback={
				<ListViewModal
					title="Select Labels"
					helpText={formatHelpText([
						{ key: "j/k", action: "Navigate" },
						{ key: "Space", action: "Toggle" },
						{ key: "Enter", action: "Confirm" },
						{ key: "Esc", action: "Cancel" },
					])}
					widthPercent={0.35}
					heightPercent={0.5}
					items={props.labels}
					selectedIndex={props.selectedIndex}
					scrollIndicatorLabel="labels"
					renderItem={(item, isSelected) => (
						<LabelRow
							label={item}
							isSelected={isSelected()}
							isToggled={isToggled(item)}
						/>
					)}
				/>
			}
		>
			<box
				position="absolute"
				left={0}
				top={0}
				width="100%"
				height="100%"
				flexDirection="column"
				justifyContent="center"
				alignItems="center"
			>
				<text fg={uiColors.primary}>Loading labels...</text>
			</box>
		</Show>
	);
}
