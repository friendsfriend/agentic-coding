/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { uiColors } from "../colors";
import { formatHelpText } from "./HelpText";
import { ListViewModal } from "./ListViewModal";

export interface CloseReasonModalProps {
	selectedIndex: number;
	onSelect: (index: number) => void;
	onSubmit: (reason: string) => void;
	onCancel: () => void;
}

const REASON_ITEMS: string[] = ["Completed", "Not planned", "Duplicate"];

const _REASON_VALUES: string[] = ["completed", "not_planned", ""];

function ReasonRow(props: { label: string; isSelected: boolean }) {
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
				{props.label}
			</text>
		</box>
	);
}

export function CloseReasonModal(props: CloseReasonModalProps) {
	return (
		<ListViewModal
			title="Close Issue — Select Reason"
			helpText={formatHelpText([
				{ key: "j/k", action: "Navigate" },
				{ key: "Enter", action: "Select" },
				{ key: "Esc", action: "Cancel" },
			])}
			widthPercent={0.35}
			heightPercent={0.35}
			items={REASON_ITEMS}
			selectedIndex={props.selectedIndex}
			scrollIndicatorLabel="reasons"
			renderItem={(item, isSelected) => (
				<ReasonRow label={item} isSelected={isSelected()} />
			)}
		/>
	);
}
