/** @jsxImportSource @opentui/solid */

import type { ChangeRequest } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { createMemo, Show } from "solid-js";
import { formatShortDate, getIssueStateColor } from "../statusUtils";
import { CenteredState } from "./CenteredState";
import { ContentPanel } from "./ContentStack";
import { FilterStatusBar } from "./FilterStatusBar";
import { HighlightedText, highlightColor } from "./Highlight";
import { LAYOUT_CHROME_LINES, ScrollableList } from "./ScrollableList";
import { SearchHeader } from "./SearchHeader";
import { WorkItemCard } from "./WorkItemCard";

interface ChangeRequestViewProps {
	changeRequests: ChangeRequest[];
	selectedIndex: number;
	onClose: () => void;
	onSelectCR?: (cr: ChangeRequest) => void;
	onSelectedIndexChange?: (index: number) => void;
	loading?: boolean;
	error?: string;
	searchMode?: boolean;
	searchQuery?: string;
	currentPage?: number;
	totalPages?: number;
	state?: string;
	sourceType?: string;
	filterSummary?: string;
	sortSummary?: string;
	runningTextEnabled?: boolean;
	runningTextOffset?: number;
}

/**
 * ChangeRequestView Component - Displays change requests as compact cards.
 *
 * PATTERN: Parent-controlled navigation (OpenTUI limitation)
 * - Parent manages selectedIndex state
 * - Parent handles ALL keyboard events via single useKeyboard hook
 * - Child is purely presentational
 */
export function ChangeRequestView(props: ChangeRequestViewProps) {
	// Lines of fixed chrome outside the list area:
	//   Layout header (2) + Layout footer (3)  = LAYOUT_CHROME_LINES (5)
	//   Top/bottom spacers + summary header    = 3
	const hasFilterStatus = () => !!props.filterSummary || !!props.sortSummary;
	const reservedLines = () =>
		LAYOUT_CHROME_LINES + 3 + (hasFilterStatus() ? 1 : 0);

	const getMergeStatusText = (cr: ChangeRequest) => {
		if (cr.has_conflicts) return { text: "✗", fg: highlightColor("negative") };
		if (cr.merge_status === "can_be_merged")
			return { text: "✓", fg: highlightColor("positive") };
		if (cr.draft || cr.work_in_progress)
			return { text: "○", fg: highlightColor("warning") };
		return { text: "○", fg: highlightColor("secondary") };
	};

	const stateHighlight = (state: string) => {
		if (state === "opened" || state === "open") return "positive" as const;
		if (state === "closed") return "negative" as const;
		if (state === "merged") return "highlight" as const;
		return "warning" as const;
	};

	const pipelineHighlight = (status?: string) => {
		const s = (status ?? "").toLowerCase();
		if (s === "success" || s === "passed") return "positive" as const;
		if (s === "failed" || s === "error" || s === "canceled")
			return "negative" as const;
		if (s === "running" || s === "pending" || s === "created")
			return "warning" as const;
		return "secondary" as const;
	};

	const summary = createMemo(() => {
		const cp = props.currentPage ?? 1;
		const tp = props.totalPages;
		const loaded = props.changeRequests.length;
		const base =
			tp && tp > 0
				? `[Pg ${cp}/${tp}] [${loaded} loaded]`
				: `[Pg ${cp}] [${loaded} loaded]`;
		return base;
	});

	const scrollSelection = (
		direction: "up" | "down" | "left" | "right",
		delta: number,
	) => {
		if (!props.onSelectedIndexChange || props.changeRequests.length === 0)
			return;
		const amount = Math.max(1, delta);
		const next =
			direction === "down" || direction === "right"
				? props.selectedIndex + amount
				: props.selectedIndex - amount;
		props.onSelectedIndexChange(
			Math.max(0, Math.min(next, props.changeRequests.length - 1)),
		);
	};

	return (
		<ContentPanel>
			<Show when={props.loading}>
				<CenteredState
					message="Loading change requests..."
					color={highlightColor("highlight")}
				/>
			</Show>

			<Show when={!props.loading && props.error}>
				<CenteredState
					message={props.error ?? ""}
					color={highlightColor("negative")}
				/>
			</Show>

			<Show when={!props.loading && !props.error}>
				<SearchHeader
					searchMode={props.searchMode}
					searchQuery={props.searchQuery}
				>
					<box style={{ width: "100%", flexDirection: "row" }}>
						<HighlightedText text="Change requests" highlight="primary" />
						<box style={{ width: "auto", flexDirection: "row", gap: 1 }}>
							<HighlightedText
								text={`[${props.state ?? "opened"}]`}
								highlight={stateHighlight(props.state ?? "opened")}
								attributes={TextAttributes.BOLD}
							/>
						</box>
						<box style={{ width: "auto", marginLeft: "auto" }}>
							<HighlightedText text={summary()} highlight="secondary" />
						</box>
					</box>
				</SearchHeader>

				<FilterStatusBar
					filterSummary={props.filterSummary}
					sortSummary={props.sortSummary}
				/>

				<Show
					when={props.changeRequests.length === 0}
					fallback={
						<ScrollableList<ChangeRequest>
							items={props.changeRequests}
							selectedIndex={props.selectedIndex}
							reservedLines={reservedLines()}
							estimatedItemHeight={2}
							showScrollIndicator={false}
							onScroll={scrollSelection}
							renderItem={(cr, isSelected, index) => {
								const mergeStatus = getMergeStatusText(cr);
								const showPipeline = props.sourceType !== "github";
								const pipeline = cr.head_pipeline?.status || "-";
								return (
									<WorkItemCard
										marker={`!${cr.iid}`}
										prefix={`${mergeStatus.text} `}
										prefixColor={mergeStatus.fg}
										title={cr.title}
										titleQuery={props.searchQuery}
										statusText={cr.state}
										statusColor={getIssueStateColor(cr.state)}
										statusBadgeHighlight={stateHighlight(cr.state)}
										metadata={`@${cr.author.name} • updated ${formatShortDate(cr.updated_at)}`}
										metadataRight={
											showPipeline ? (
												<HighlightedText
													text={`pipeline ${pipeline}`}
													highlight={pipelineHighlight(
														cr.head_pipeline?.status,
													)}
												/>
											) : undefined
										}
										metadataRightWidth={
											showPipeline ? `pipeline ${pipeline}`.length : 0
										}
										selected={isSelected()}
										index={index}
										onMouseUp={
											props.onSelectCR
												? () => props.onSelectCR?.(cr)
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
					<CenteredState
						message="No change requests found"
						color={highlightColor("secondary")}
					/>
				</Show>
			</Show>
		</ContentPanel>
	);
}
