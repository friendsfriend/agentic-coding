/** @jsxImportSource @opentui/solid */

import type { Issue, IssueScope } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { createMemo, Show } from "solid-js";
import { uiColors } from "../colors";
import { formatShortDate, getIssueStateColor } from "../statusUtils";
import { CenteredState } from "./CenteredState";
import { ContentPanel } from "./ContentStack";
import { FilterStatusBar } from "./FilterStatusBar";
import { highlightForIndex } from "./Highlight";
import { LAYOUT_CHROME_LINES, ScrollableList } from "./ScrollableList";
import { SearchHeader } from "./SearchHeader";
import { WorkItemCard } from "./WorkItemCard";

interface IssueViewProps {
	issues: Issue[];
	selectedIndex: number;
	onClose?: () => void;
	onSelectIssue?: (issue: Issue) => void;
	onSelectedIndexChange?: (index: number) => void;
	loading?: boolean;
	error?: string;
	searchMode?: boolean;
	searchQuery?: string;
	currentPage?: number;
	totalPages?: number;
	totalCount?: number;
	scope?: IssueScope;
	state?: string;
	filterSummary?: string;
	sortSummary?: string;
	runningTextEnabled?: boolean;
	runningTextOffset?: number;
}

/**
 * IssueView Component - Displays issues as compact cards.
 *
 * PATTERN: Parent-controlled navigation (OpenTUI limitation)
 * - Parent manages selectedIndex state
 * - Parent handles ALL keyboard events via single useKeyboard hook
 * - Child is purely presentational
 */
export function IssueView(props: IssueViewProps) {
	// Lines of fixed chrome outside the list area:
	//   Layout header (2) + Layout footer (3)  = LAYOUT_CHROME_LINES (5)
	//   Top/bottom spacers + summary header    = 3
	const hasFilterStatus = () => !!props.filterSummary || !!props.sortSummary;
	const reservedLines = () =>
		LAYOUT_CHROME_LINES + 3 + (hasFilterStatus() ? 1 : 0);

	const stateColor = () => {
		const s = props.state || "open";
		if (s === "open" || s === "opened") return uiColors.success;
		if (s === "closed") return uiColors.error;
		return uiColors.primary; // "all"
	};

	const summary = () => {
		const cp = props.currentPage ?? 1;
		const tp = props.totalPages;
		const pageLabel = tp && tp > 0 ? `Pg ${cp}/${tp}` : `Pg ${cp}/?`;
		const loadedLabel = `${props.issues.length} loaded`;
		return `${pageLabel}  ${loadedLabel}`;
	};

	const labelHighlightByName = createMemo(() => {
		const map = new Map<string, ReturnType<typeof highlightForIndex>>();
		for (const issue of props.issues) {
			for (const label of issue.labels ?? []) {
				if (!map.has(label)) map.set(label, highlightForIndex(map.size));
			}
		}
		return map;
	});

	const scrollSelection = (
		direction: "up" | "down" | "left" | "right",
		delta: number,
	) => {
		if (!props.onSelectedIndexChange || props.issues.length === 0) return;
		const amount = Math.max(1, delta);
		const next =
			direction === "down" || direction === "right"
				? props.selectedIndex + amount
				: props.selectedIndex - amount;
		props.onSelectedIndexChange(
			Math.max(0, Math.min(next, props.issues.length - 1)),
		);
	};

	return (
		<ContentPanel>
			<Show when={props.loading}>
				<CenteredState message="Loading issues..." color={uiColors.primary} />
			</Show>

			<Show when={!props.loading && props.error}>
				<CenteredState message={props.error ?? ""} color={uiColors.error} />
			</Show>

			<Show when={!props.loading && !props.error}>
				<SearchHeader
					searchMode={props.searchMode}
					searchQuery={props.searchQuery}
				>
					<box style={{ width: "100%", flexDirection: "row" }}>
						<text fg={uiColors.textPrimary}>Issues</text>
						<box style={{ width: "auto", flexDirection: "row", gap: 1 }}>
							<Show when={props.scope && props.scope !== "all"}>
								<text
									fg={uiColors.textPrimary}
									attributes={TextAttributes.BOLD}
								>{`[${props.scope}]`}</text>
							</Show>
							<text
								fg={stateColor()}
								attributes={TextAttributes.BOLD}
							>{`[${props.state ?? "open"}]`}</text>
						</box>
						<box style={{ width: "auto", marginLeft: "auto" }}>
							<text fg={uiColors.textMuted}>{summary()}</text>
						</box>
					</box>
				</SearchHeader>

				<FilterStatusBar
					filterSummary={props.filterSummary}
					sortSummary={props.sortSummary}
				/>

				<Show
					when={props.issues.length === 0}
					fallback={
						<ScrollableList<Issue>
							items={props.issues}
							selectedIndex={props.selectedIndex}
							reservedLines={reservedLines()}
							estimatedItemHeight={2}
							showScrollIndicator={false}
							onScroll={scrollSelection}
							renderItem={(issue, isSelected, index) => {
								const labels = issue.labels ?? [];
								const labelBadges = labels.map((label) => ({
									text: label,
									highlight: labelHighlightByName().get(label) ?? "highlight1",
								}));
								const metadata = `@${issue.author.name} • updated ${formatShortDate(issue.updated_at)}`;
								return (
									<WorkItemCard
										marker={`#${issue.iid}`}
										title={issue.title}
										titleQuery={props.searchQuery}
										statusText={issue.state}
										statusColor={getIssueStateColor(issue.state)}
										statusBadgeHighlight={
											issue.state === "open" || issue.state === "opened"
												? "positive"
												: issue.state === "merged"
													? "highlight"
													: "secondary"
										}
										metadata={metadata}
										metadataBadges={labelBadges}
										selected={isSelected()}
										index={index}
										onMouseUp={
											props.onSelectIssue
												? () => props.onSelectIssue?.(issue)
												: undefined
										}
										runningTextEnabled={props.runningTextEnabled}
										runningTextOffset={props.runningTextOffset}
									/>
								);
							}}
						/>
					}
				>
					<CenteredState message="No issues found" />
				</Show>
			</Show>
		</ContentPanel>
	);
}
