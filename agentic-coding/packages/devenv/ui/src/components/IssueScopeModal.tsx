/** @jsxImportSource @opentui/solid */

import type { IssueScope } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { uiColors } from "../colors";
import { formatHelpText } from "./HelpText";
import { ListViewModal } from "./ListViewModal";

export interface IssueScopeOption {
	label: string;
	value: IssueScope;
}

export const ISSUE_SCOPE_OPTIONS: IssueScopeOption[] = [
	{ label: "All issues", value: "all" },
	{ label: "Assigned to me", value: "assigned-to-me" },
	{ label: "Created by me", value: "created-by-me" },
	{ label: "No assignee", value: "no-assignee" },
];

interface IssueScopeModalProps {
	selectedIndex: number;
}

function ScopeRow(props: { label: string; isSelected: boolean }) {
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

export function IssueScopeModal(props: IssueScopeModalProps) {
	return (
		<ListViewModal
			title="Select Issue Scope"
			helpText={formatHelpText([
				{ key: "j/k", action: "Navigate" },
				{ key: "Enter", action: "Select" },
				{ key: "Esc", action: "Cancel" },
			])}
			widthPercent={0.3}
			heightPercent={0.4}
			items={ISSUE_SCOPE_OPTIONS.map((option) => option.label)}
			selectedIndex={props.selectedIndex}
			scrollIndicatorLabel="scopes"
			renderItem={(item, isSelected) => (
				<ScopeRow label={item} isSelected={isSelected()} />
			)}
		/>
	);
}
