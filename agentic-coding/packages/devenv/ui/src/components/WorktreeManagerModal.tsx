/** @jsxImportSource @opentui/solid */

import type { WorktreeInfo } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { uiColors } from "../colors";
import { formatHelpText } from "./HelpText";
import { ListViewModal } from "./ListViewModal";

export interface WorktreeManagerModalProps {
	appName: string;
	worktrees: WorktreeInfo[];
	selectedIndex: number;
}

function WorktreeRow(props: { worktree: WorktreeInfo; isSelected: boolean }) {
	const label = () => {
		const parts: string[] = [props.worktree.branch];
		if (props.worktree.active) parts.push("✓");
		if (props.worktree.isMain) parts.push("[main]");
		return parts.join(" ");
	};

	const color = () => {
		if (props.worktree.active) return uiColors.primary;
		if (props.worktree.isMain) return uiColors.success;
		return uiColors.textPrimary;
	};

	const isBold = () =>
		props.worktree.active || props.worktree.isMain || props.isSelected;

	return (
		<box
			backgroundColor={props.isSelected ? uiColors.bgSurface0 : undefined}
			style={{
				width: "100%",
				height: 2,
				paddingLeft: 1,
				paddingRight: 1,
				flexDirection: "column",
			}}
		>
			<text
				fg={color()}
				attributes={isBold() ? TextAttributes.BOLD : undefined}
			>
				{label()}
			</text>
			<text fg={uiColors.textMuted} style={{ paddingLeft: 4 }}>
				{props.worktree.path.split("/").filter(Boolean).pop() ??
					props.worktree.path}
			</text>
		</box>
	);
}

/**
 * WorktreeManagerModal — lists all worktrees for a scoped repository.
 * Navigation and deletion are handled by worktree-manager-keys.ts.
 */
export function WorktreeManagerModal(props: WorktreeManagerModalProps) {
	return (
		<ListViewModal
			title={`Worktrees — ${props.appName}`}
			helpText={formatHelpText([
				{ key: "j/k", action: "Navigate" },
				{ key: "Enter", action: "Switch" },
				{ key: "n", action: "New worktree" },
				{ key: "d", action: "Delete" },
				{ key: "Esc/q", action: "Close" },
			])}
			widthPercent={0.55}
			heightPercent={0.6}
			items={props.worktrees}
			selectedIndex={props.selectedIndex}
			estimatedItemHeight={2}
			scrollIndicatorLabel="worktrees"
			emptyContent={
				<text fg={uiColors.textSecondary}>
					No worktrees found for this repository.
				</text>
			}
			renderItem={(worktree, isSelected) => (
				<WorktreeRow worktree={worktree} isSelected={isSelected()} />
			)}
		/>
	);
}
