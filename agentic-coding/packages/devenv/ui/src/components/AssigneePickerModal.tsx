/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { uiColors } from "../colors";
import { formatHelpText } from "./HelpText";
import { ListViewModal } from "./ListViewModal";

export interface AssigneePickerModalProps {
	collaborators: string[];
	currentAssignee: string;
	selectedIndex: number;
	loading: boolean;
	onSelect: (index: number) => void;
	onPick: (assignee: string) => void;
	onCancel: () => void;
}

function AssigneeRow(props: {
	name: string;
	isSelected: boolean;
	isCurrentAssignee: boolean;
}) {
	const badge = () => (props.isCurrentAssignee ? "✓ " : "  ");

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
				{badge()}
				{props.name}
				{props.isCurrentAssignee ? " (current)" : ""}
			</text>
		</box>
	);
}

export function AssigneePickerModal(props: AssigneePickerModalProps) {
	return (
		<Show
			when={props.loading}
			fallback={
				<ListViewModal
					title="Select Assignee"
					helpText={formatHelpText([
						{ key: "j/k", action: "Navigate" },
						{
							key: "Enter",
							action: props.currentAssignee ? "Set / Remove" : "Set",
						},
						{ key: "Esc", action: "Cancel" },
					])}
					widthPercent={0.35}
					heightPercent={0.5}
					items={props.collaborators}
					selectedIndex={props.selectedIndex}
					scrollIndicatorLabel="collaborators"
					renderItem={(item, isSelected) => (
						<AssigneeRow
							name={item}
							isSelected={isSelected()}
							isCurrentAssignee={item === props.currentAssignee}
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
				<text fg={uiColors.primary}>Loading collaborators...</text>
			</box>
		</Show>
	);
}
