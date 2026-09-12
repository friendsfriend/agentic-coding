/** @jsxImportSource @opentui/solid */

import type { AgentGroup, AgentSessionInfo } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { createMemo } from "solid-js";
import { uiColors } from "../colors";
import { formatHelpText } from "./HelpText";
import { highlightColor } from "./Highlight";
import { ListViewModal } from "./ListViewModal";
import { MatchedText } from "./MatchedText";

export interface AgentSpaceViewProps {
	piAgentGroups: AgentGroup[];
	sessionsLoading: boolean;
	selectedIndex: number;
	searchQuery?: string;
	filterQuery?: string;
	filterActive?: boolean;
	onFilterChange?: (query: string) => void;
}

export type FlatRow =
	| { kind: "new" }
	| { kind: "pi-session"; session: AgentSessionInfo; agentName: string };

function formatRelativeTime(updatedAtUnixMs: number): string {
	if (!updatedAtUnixMs || Number.isNaN(updatedAtUnixMs)) return "";
	const diffSec = Math.max(
		0,
		Math.floor((Date.now() - updatedAtUnixMs) / 1000),
	);
	if (diffSec < 60) return `${diffSec}s ago`;
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHour = Math.floor(diffMin / 60);
	if (diffHour < 24) return `${diffHour}h ago`;
	const diffDay = Math.floor(diffHour / 24);
	return `${diffDay}d ago`;
}

export function getSelectableRows(
	rows: FlatRow[],
): Array<{ row: FlatRow; flatIndex: number }> {
	const result: Array<{ row: FlatRow; flatIndex: number }> = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row.kind === "new" || row.kind === "pi-session") {
			result.push({ row, flatIndex: i });
		}
	}
	return result;
}

function RowView(props: { row: FlatRow; isSelected: boolean; query?: string }) {
	if (props.row.kind === "new") {
		return (
			<box
				backgroundColor={props.isSelected ? uiColors.bgSurface0 : undefined}
				style={{
					width: "100%",
					height: 1,
					flexDirection: "row",
					flexShrink: 0,
					paddingLeft: 1,
				}}
			>
				<text
					fg={props.isSelected ? uiColors.success : uiColors.textMuted}
					attributes={props.isSelected ? TextAttributes.BOLD : undefined}
				>
					+ New Session
				</text>
			</box>
		);
	}

	return (
		<box
			backgroundColor={props.isSelected ? uiColors.bgSurface0 : undefined}
			style={{
				width: "100%",
				height: 1,
				flexDirection: "row",
				flexShrink: 0,
				paddingLeft: 1,
			}}
		>
			<text fg={highlightColor("secondary")} style={{ flexShrink: 0 }}>
				{`[${props.row.agentName}] `}
			</text>
			<box style={{ flexGrow: 1, overflow: "hidden" }}>
				<MatchedText
					text={props.row.session.title || "(untitled)"}
					query={props.query}
					fg={props.isSelected ? uiColors.textPrimary : uiColors.textSecondary}
					attributes={props.isSelected ? TextAttributes.BOLD : undefined}
				/>
			</box>
			<text fg={highlightColor("secondary")}>
				{` ${formatRelativeTime(props.row.session.timeUpdated)}`}
			</text>
		</box>
	);
}

const HEIGHT_PERCENT = 0.75;

export function AgentSpaceView(props: AgentSpaceViewProps) {
	const query = () => (props.searchQuery ?? "").toLowerCase();

	const rows = createMemo<FlatRow[]>(() => {
		const allSessions: Array<{ session: AgentSessionInfo; agentName: string }> =
			[];
		for (const group of props.piAgentGroups ?? []) {
			for (const session of group.sessions) {
				if (!query() || (session.title || "").toLowerCase().includes(query())) {
					allSessions.push({ session, agentName: group.name });
				}
			}
		}
		allSessions.sort((a, b) => b.session.timeUpdated - a.session.timeUpdated);

		const built: FlatRow[] = [{ kind: "new" }];
		for (const entry of allSessions) {
			built.push({
				kind: "pi-session",
				session: entry.session,
				agentName: entry.agentName,
			});
		}
		return built;
	});

	const selectableRows = createMemo(() => getSelectableRows(rows()));
	const clampedSelectableIndex = createMemo(() => {
		const selectable = selectableRows();
		if (selectable.length === 0) return -1;
		return Math.max(0, Math.min(props.selectedIndex, selectable.length - 1));
	});
	const selectedFlatIndex = createMemo(() => {
		const idx = clampedSelectableIndex();
		if (idx < 0) return -1;
		return selectableRows()[idx].flatIndex;
	});

	const helpText = createMemo(() =>
		formatHelpText([
			{ key: "ctrl+j/k", action: "Navigate" },
			{ key: "/", action: "Filter" },
			{ key: "Enter", action: "Launch/Resume" },
			{ key: "Esc", action: "Close" },
		]),
	);

	return (
		<ListViewModal
			title="pi Agent Sessions"
			helpText={helpText()}
			widthPercent={0.75}
			heightPercent={HEIGHT_PERCENT}
			items={rows()}
			selectedIndex={selectedFlatIndex()}
			loading={props.sessionsLoading}
			loadingText="Loading sessions..."
			filterPlaceholder="filter sessions..."
			scrollIndicatorLabel="sessions"
			filterQuery={props.filterQuery}
			filterActive={props.filterActive}
			onFilterChange={props.onFilterChange}
			emptyContent={
				<text fg={highlightColor("secondary")}>No sessions found.</text>
			}
			renderItem={(item, isSelected) => (
				<RowView
					row={item}
					isSelected={isSelected()}
					query={props.searchQuery}
				/>
			)}
		/>
	);
}
