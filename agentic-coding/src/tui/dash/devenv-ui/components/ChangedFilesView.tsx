/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { createMemo, Show } from "solid-js";
import { uiColors } from "../colors";
import type { ChangeRequestChange } from "../types";
import { Badge } from "./Badge";
import { CenteredState } from "./CenteredState";
import { ContentPanel } from "./ContentStack";
import { FilterStatusBar } from "./FilterStatusBar";
import { HighlightedText, highlightColor } from "./Highlight";
import { MatchedText } from "./MatchedText";
import { LAYOUT_CHROME_LINES, ScrollableList } from "./ScrollableList";
import { SearchHeader } from "./SearchHeader";

interface ChangedFilesViewProps {
	changes: ChangeRequestChange[];
	selectedIndex: number;
	onClose: () => void;
	loading?: boolean;
	error?: string;
	searchMode?: boolean;
	searchQuery?: string;
	filterSummary?: string;
	sortSummary?: string;
	/**
	 * When set, renders without the full-screen ContentPanel chrome (the
	 * embedding modal provides its own panel) and sizes the ScrollableList to
	 * this many lines. ScrollableList prefers `availableLines` over
	 * `reservedLines`; see its docs. Absent = current full-screen behavior.
	 */
	availableLines?: number;
}

/**
 * ChangedFilesView Component - Displays changed files in a change request
 * Shows file paths, change types, and diff statistics
 *
 * PATTERN: Parent-controlled navigation (OpenTUI limitation)
 * - Parent manages selectedIndex state
 * - Parent handles ALL keyboard events via single useKeyboard hook
 * - Child is purely presentational
 */
export function ChangedFilesView(props: ChangedFilesViewProps) {
	// Get change type and color
	const getChangeType = (change: ChangeRequestChange) => {
		if (change.new_file) return { type: "+", highlight: "positive" as const };
		if (change.deleted_file)
			return { type: "-", highlight: "negative" as const };
		if (change.renamed_file)
			return { type: "→", highlight: "highlight2" as const };
		return { type: "~", highlight: "warning" as const };
	};

	// Get file path (show new_path for renamed/new, old_path for deleted)
	const getFilePath = (change: ChangeRequestChange) => {
		if (change.renamed_file) {
			return `${change.old_path} → ${change.new_path}`;
		}
		return change.new_path || change.old_path;
	};

	// Calculate total stats
	const totalStats = createMemo(() => {
		let totalAdded = 0;
		let totalDeleted = 0;

		for (const change of props.changes) {
			totalAdded += change.lines_added || 0;
			totalDeleted += change.lines_deleted || 0;
		}

		return { totalAdded, totalDeleted, totalFiles: props.changes.length };
	});

	// Lines of fixed chrome outside the list area:
	//   Layout header (2) + Layout footer (3)  = LAYOUT_CHROME_LINES (5)
	//   Outer rounded border top + bottom      = 2
	//   Own header rows (title + stats)        = 2
	//   Table header row                       = 1
	//                                   Total  = 11
	const reservedLines = () => LAYOUT_CHROME_LINES + 2 + 2 + 1 + 1;

	const embedded = () => props.availableLines !== undefined;

	const content = (
		<>
			<Show when={props.loading}>
				<CenteredState
					message="Loading changed files..."
					color={highlightColor("highlight")}
					bold
				/>
			</Show>

			{props.error && (
				<CenteredState
					message={props.error}
					color={highlightColor("negative")}
					bold
				/>
			)}

			{/* Content */}
			<Show when={!props.loading && !props.error}>
				{/* Header */}
				<box
					style={{
						width: "100%",
						height: 2,
						flexDirection: "column",
						paddingLeft: 1,
						paddingRight: 1,
					}}
				>
					<HighlightedText
						text={`Changed Files (${totalStats().totalFiles} files)`}
						highlight="primary"
						attributes={TextAttributes.BOLD}
					/>
					<text fg={highlightColor("secondary")}>
						<span style={{ fg: highlightColor("positive") }}>
							+{totalStats().totalAdded}
						</span>{" "}
						<span style={{ fg: highlightColor("negative") }}>
							-{totalStats().totalDeleted}
						</span>
					</text>
				</box>

				{/* Table Header */}
				<SearchHeader
					searchMode={props.searchMode}
					searchQuery={props.searchQuery}
					resultCount={props.changes.length}
				>
					<box style={{ width: 5 }}>
						<HighlightedText
							text="Type"
							highlight="primary"
							attributes={TextAttributes.BOLD}
						/>
					</box>
					<box style={{ width: "58%" }}>
						<HighlightedText
							text="File Path"
							highlight="primary"
							attributes={TextAttributes.BOLD}
						/>
					</box>
					<box style={{ width: "25%" }}>
						<HighlightedText
							text="Changes (+/-)"
							highlight="primary"
							attributes={TextAttributes.BOLD}
						/>
					</box>
					<box style={{ width: "12%" }}>
						<HighlightedText
							text="Findings"
							highlight="primary"
							attributes={TextAttributes.BOLD}
						/>
					</box>
				</SearchHeader>

				<FilterStatusBar
					filterSummary={props.filterSummary}
					sortSummary={props.sortSummary}
				/>

				{/* Empty State */}
				<Show when={props.changes.length === 0}>
					<CenteredState
						message="No changed files"
						color={highlightColor("secondary")}
					/>
				</Show>

				{/* Table Rows — rendered via ScrollableList for correct virtual windowing */}
				<ScrollableList<ChangeRequestChange>
					items={props.changes}
					selectedIndex={props.selectedIndex}
					availableLines={props.availableLines}
					reservedLines={embedded() ? undefined : reservedLines()}
					estimatedItemHeight={1}
					showScrollIndicator={false}
					renderItem={(change, isSelected) => {
						const changeType = getChangeType(change);
						const filePath = getFilePath(change);
						return (
							<box
								backgroundColor={isSelected() ? uiColors.bgSurface0 : undefined}
								style={{
									width: "100%",
									height: 1,
									flexDirection: "row",
								}}
							>
								{/* Accent marker strip */}
								<box
									backgroundColor={
										isSelected() ? uiColors.highlight : undefined
									}
									style={{ width: 2, flexShrink: 0 }}
								/>
								<box
									style={{
										flexGrow: 1,
										flexDirection: "row",
										paddingLeft: 1,
										paddingRight: 1,
									}}
								>
									{/* Type */}
									<box style={{ width: 5 }}>
										<Badge
											text={changeType.type}
											highlight={changeType.highlight}
										/>
									</box>
									{/* File Path */}
									<box style={{ width: "58%" }}>
										<MatchedText
											text={filePath}
											query={props.searchQuery}
											fg={highlightColor(
												isSelected() ? "primary" : "secondary",
											)}
											attributes={
												isSelected() ? TextAttributes.BOLD : undefined
											}
										/>
									</box>
									{/* Stats */}
									<box style={{ width: "25%" }}>
										<text
											fg={highlightColor(
												isSelected() ? "primary" : "secondary",
											)}
										>
											<span style={{ fg: highlightColor("positive") }}>
												+{change.lines_added || 0}
											</span>{" "}
											<span style={{ fg: highlightColor("negative") }}>
												-{change.lines_deleted || 0}
											</span>
										</text>
									</box>
									<box style={{ width: "12%" }}>
										<text
											fg={
												change.review_finding_count
													? uiColors.warning
													: highlightColor("secondary")
											}
										>
											{change.review_finding_count || 0}
										</text>
									</box>
								</box>
							</box>
						);
					}}
				/>
			</Show>
		</>
	);

	return embedded() ? content : <ContentPanel>{content}</ContentPanel>;
}
