/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { createMemo, Show } from "solid-js";
import { uiColors } from "../colors";
import { formatHelpText } from "./HelpText";
import { highlightColor } from "./Highlight";
import { ListViewModal } from "./ListViewModal";

export interface BranchInfo {
	name: string;
	isRemote: boolean;
}

export interface BranchSelectorProps {
	branches: BranchInfo[];
	currentBranch: string;
	selectedIndex: number;
	appName: string;
	loading?: boolean;
	filterQuery?: string;
	filterActive?: boolean;
	/** When true, Enter creates a new worktree instead of checking out */
	worktreeCreateMode?: boolean;
	onFilterChange?: (query: string) => void;
	onSelectedIndexChange?: (index: number) => void;
	onCreateBranch?: (branchName: string) => void;
}

// Branch row component
function BranchRow(props: {
	branchInfo: BranchInfo;
	isSelected: boolean;
	isCurrent: boolean;
}) {
	const branchColor = () => {
		if (props.isCurrent) return uiColors.primary;
		return props.branchInfo.isRemote ? uiColors.success : uiColors.textPrimary;
	};

	const isBold = () =>
		props.isCurrent || !props.branchInfo.isRemote || props.isSelected;
	const suffix = () => (props.isCurrent ? " (current)" : "");

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
				fg={branchColor()}
				attributes={isBold() ? TextAttributes.BOLD : undefined}
			>
				{props.branchInfo.name}
				{suffix()}
			</text>
		</box>
	);
}

/**
 * Branch selector modal component
 * Displays a list of branches with keyboard navigation and filtering.
 * Filter is activated by pressing / (handled in table-keys.ts).
 */
export function BranchSelectorView(props: BranchSelectorProps) {
	const filterQuery = () => props.filterQuery ?? "";

	// Branches are pre-filtered by uiStore.filteredBranches() before being
	// passed in. effectiveSelectedIndex clamps in case the list shrank.
	const effectiveSelectedIndex = createMemo(() =>
		Math.min(props.selectedIndex, Math.max(0, props.branches.length - 1)),
	);

	return (
		<ListViewModal
			title={
				props.worktreeCreateMode
					? `New Worktree — ${props.appName}`
					: `Select Branch - ${props.appName}`
			}
			helpText={formatHelpText(
				props.worktreeCreateMode
					? [
							{ key: "↑/↓", action: "Navigate" },
							{
								key: "Enter",
								action:
									filterQuery() && props.branches.length === 0
										? "Create new worktree"
										: "Create worktree on branch",
							},
							{ key: "/", action: "Filter" },
							{ key: "Esc", action: "Cancel" },
						]
					: [
							{ key: "↑/↓", action: "Navigate" },
							{ key: "Enter/s", action: "Switch" },
							{ key: "g", action: "Status" },
							{ key: "Shift+L", action: "Log" },
							{ key: "f", action: "Fetch" },
							{ key: "p", action: "Pull" },
							{ key: "P", action: "Push" },
							{ key: "ctrl+n", action: "Create" },
							{ key: "Esc", action: "Cancel" },
						],
			)}
			widthPercent={0.5}
			heightPercent={0.7}
			items={props.branches}
			selectedIndex={effectiveSelectedIndex()}
			loading={props.loading}
			loadingText="Loading branches..."
			reservedHeight={2}
			scrollIndicatorLabel={
				filterQuery()
					? `branches (filtered from ${props.branches.length})`
					: "branches"
			}
			filterPlaceholder="filter branches..."
			filterQuery={filterQuery()}
			filterActive={props.filterActive}
			onFilterChange={props.onFilterChange}
			header={
				<box
					style={{
						width: "100%",
						height: 1,
						justifyContent: "center",
						marginBottom: 1,
						flexDirection: "row",
						flexShrink: 0,
					}}
				>
					<text style={{ fg: uiColors.textSecondary }}>Current: </text>
					<text
						fg={highlightColor("positive")}
						attributes={TextAttributes.BOLD}
					>
						{props.currentBranch}
					</text>
				</box>
			}
			emptyContent={
				<Show
					when={filterQuery() && props.worktreeCreateMode}
					fallback={
						<Show
							when={filterQuery()}
							fallback={
								<text
									fg={highlightColor("highlight")}
									attributes={TextAttributes.BOLD}
								>
									No branches found
								</text>
							}
						>
							<text
								fg={highlightColor("highlight")}
								attributes={TextAttributes.BOLD}
							>
								No branches matching "{filterQuery()}"
							</text>
						</Show>
					}
				>
					<text fg={highlightColor("secondary")}>
						No existing branch matches "{filterQuery()}".
					</text>
					<text
						fg={highlightColor("positive")}
						attributes={TextAttributes.BOLD}
					>
						Press Enter to create a new worktree on branch "{filterQuery()}".
					</text>
				</Show>
			}
			renderItem={(branchInfo, isSelected) => {
				const branchWithoutOrigin = branchInfo.name.startsWith("origin/")
					? branchInfo.name.substring(7)
					: branchInfo.name;
				const isCurrent =
					branchInfo.name === props.currentBranch ||
					branchWithoutOrigin === props.currentBranch;

				return (
					<BranchRow
						branchInfo={branchInfo}
						isSelected={isSelected()}
						isCurrent={isCurrent}
					/>
				);
			}}
		/>
	);
}
