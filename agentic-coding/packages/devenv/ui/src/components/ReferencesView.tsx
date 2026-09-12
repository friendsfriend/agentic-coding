/** @jsxImportSource @opentui/solid */

import type { ChangeRequest, Issue } from "@devenv/types";
import { Show } from "solid-js";
import { formatShortDate, getIssueStateColor } from "../statusUtils";
import { CenteredState } from "./CenteredState";
import { ContentPanel } from "./ContentStack";
import { FilterStatusBar } from "./FilterStatusBar";
import { HighlightedText, highlightColor } from "./Highlight";
import { LAYOUT_CHROME_LINES, ScrollableList } from "./ScrollableList";
import { SearchHeader } from "./SearchHeader";
import { WorkItemCard } from "./WorkItemCard";

type RefItem =
	| { type: "cr"; data: ChangeRequest }
	| { type: "issue"; data: Issue };

interface ReferencesViewProps {
	references: RefItem[];
	allReferencesCount?: number;
	selectedIndex: number;
	loading: boolean;
	error: string;
	onClose: () => void;
	activeFilters?: Record<string, string[]>;
	sortRules?: Array<{
		key: string;
		label: string;
		direction: "asc" | "desc" | "none";
	}>;
	runningTextEnabled?: boolean;
	runningTextOffset?: number;
}

/**
 * ReferencesView Component — Full-screen sub-view of combined references (issues + CRs).
 */
export function ReferencesView(props: ReferencesViewProps) {
	const reservedLines = () => LAYOUT_CHROME_LINES + 3 + 1;

	const typeLabel = (ref: RefItem) => (ref.type === "cr" ? "CR" : "Issue");
	const typeHighlight = (ref: RefItem) =>
		ref.type === "cr" ? ("highlight1" as const) : ("highlight2" as const);
	const stateHighlight = (state: string) => {
		if (state === "opened" || state === "open") return "positive" as const;
		if (state === "merged") return "highlight1" as const;
		if (state === "closed") return "secondary" as const;
		return "warning" as const;
	};
	const filterSummary = () => {
		const filters = props.activeFilters ?? {};
		const parts = Object.entries(filters)
			.filter(([, values]) => values.length > 0)
			.map(([key, values]) => `${key}: ${values.join(",")}`);
		return parts.length ? `filters ${parts.join(" • ")}` : "";
	};
	const sortSummary = () => {
		const active = (props.sortRules ?? []).filter(
			(rule) => rule.direction !== "none",
		);
		if (active.length === 0) return "";
		return active
			.map((rule) => `${rule.label} ${rule.direction === "asc" ? "↑" : "↓"}`)
			.join(" • ");
	};
	const countSummary = () =>
		props.allReferencesCount !== undefined &&
		props.allReferencesCount !== props.references.length
			? `${props.references.length}/${props.allReferencesCount} loaded`
			: `${props.references.length} loaded`;

	return (
		<ContentPanel>
			<Show when={props.loading}>
				<CenteredState
					message="Loading references..."
					color={highlightColor("highlight")}
				/>
			</Show>

			<Show when={!props.loading && props.error}>
				<CenteredState
					message={props.error}
					color={highlightColor("negative")}
				/>
			</Show>

			<Show when={!props.loading && !props.error}>
				<box style={{ width: "100%", flexDirection: "column" }}>
					<SearchHeader>
						<box style={{ width: "100%", flexDirection: "row" }}>
							<HighlightedText text="References" highlight="primary" />
							<box style={{ width: "auto", marginLeft: "auto" }}>
								<HighlightedText text={countSummary()} highlight="secondary" />
							</box>
						</box>
					</SearchHeader>
					<FilterStatusBar
						filterSummary={filterSummary()}
						sortSummary={sortSummary()}
					/>
				</box>

				<Show
					when={props.references.length === 0}
					fallback={
						<ScrollableList<RefItem>
							items={props.references}
							selectedIndex={props.selectedIndex}
							reservedLines={reservedLines()}
							estimatedItemHeight={2}
							showScrollIndicator={false}
							renderItem={(ref, isSelected, index) => (
								<WorkItemCard
									marker={`${ref.type === "cr" ? "!" : "#"}${ref.data.iid}`}
									prefixBadge={{
										text: typeLabel(ref),
										highlight: typeHighlight(ref),
									}}
									title={ref.data.title}
									statusText={ref.data.state}
									statusColor={getIssueStateColor(ref.data.state)}
									statusBadgeHighlight={stateHighlight(ref.data.state)}
									metadata={`@${ref.data.author.name} • updated ${formatShortDate(ref.data.updated_at)}`}
									selected={isSelected()}
									index={index}
									runningTextEnabled={props.runningTextEnabled}
									runningTextOffset={props.runningTextOffset}
								/>
							)}
						/>
					}
				>
					<CenteredState
						message="No references"
						color={highlightColor("secondary")}
					/>
				</Show>
			</Show>
		</ContentPanel>
	);
}
