/** @jsxImportSource @opentui/solid */
// Changed files table — one implementation for the env surface and the shell.
//
// Full-page use renders inside `ContentPanel` and reserves the host chrome; an
// embedding dialog passes `availableLines` (the dialog's content rows), which
// drops the panel chrome and sizes the list to the dialog instead.
import type { ChangeRequestChange } from "@devenv/types";

/** The shell's review rows carry a finding count the env type does not declare. */
type ReviewChange = ChangeRequestChange & { review_finding_count?: number };

import { TextAttributes } from "@opentui/core";
import { createMemo, Show } from "solid-js";
import { uiColors } from "../theme/colors";
import { Badge } from "./Badge";
import { CenteredState } from "./CenteredState";
import { ContentPanel } from "./ContentStack";
import { FilterStatusBar } from "./FilterStatusBar";
import { HighlightedText, highlightColor } from "./Highlight";
import { hostChromeLines, hostNamesPage } from "./hostChrome";
import { MatchedText } from "./MatchedText";
import { LAYOUT_CHROME_LINES, ScrollableList } from "./ScrollableList";
import { SearchHeader } from "./SearchHeader";

export interface ChangedFilesViewProps {
	changes: ReviewChange[];
	selectedIndex: number;
	onClose: () => void;
	loading?: boolean;
	error?: string;
	searchMode?: boolean;
	searchQuery?: string;
	filterSummary?: string;
	sortSummary?: string;
	/**
	 * Content rows available when the view is embedded in a dialog. Absent =
	 * full-page behaviour: the view renders its own panel and reserves the host
	 * chrome.
	 */
	availableLines?: number;
	/** Show the review-findings column (the shell's review dialog). */
	findings?: boolean;
}

/**
 * Changed files table: file paths, change type and diff statistics.
 *
 * Navigation stays with the caller (parent-controlled selection, all keys
 * handled by the parent's single keyboard layer); this is presentational.
 */
export function ChangedFilesView(props: ChangedFilesViewProps) {
	const embedded = () => props.availableLines !== undefined;

	const getChangeType = (change: ChangeRequestChange) => {
		if (change.new_file) return { type: "+", highlight: "positive" as const };
		if (change.deleted_file)
			return { type: "-", highlight: "negative" as const };
		if (change.renamed_file)
			return { type: "→", highlight: "highlight2" as const };
		return { type: "~", highlight: "warning" as const };
	};

	const getFilePath = (change: ChangeRequestChange) => {
		if (change.renamed_file) return `${change.old_path} → ${change.new_path}`;
		return change.new_path || change.old_path;
	};

	const totalStats = createMemo(() => {
		let totalAdded = 0;
		let totalDeleted = 0;
		for (const change of props.changes) {
			totalAdded += change.lines_added || 0;
			totalDeleted += change.lines_deleted || 0;
		}
		return { totalAdded, totalDeleted, totalFiles: props.changes.length };
	});

	/**
	 * Fixed chrome outside the list: the host's chrome (header/footer), the
	 * panel's rounded borders, this view's two header rows and the table header.
	 */
	const reservedLines = () =>
		hostChromeLines(LAYOUT_CHROME_LINES) + 2 + 2 + 1 + 1;

	const pathWidth = () =>
		(props.findings ? "52%" : "58%") as `${number}%` | number;
	const statsWidth = () => "25%" as `${number}%` | number;

	const content = (
		<>
			<Show when={props.loading}>
				<CenteredState
					message="Loading changed files..."
					color={highlightColor("highlight")}
					bold
				/>
			</Show>

			<Show when={props.error}>
				<CenteredState
					message={props.error ?? ""}
					color={highlightColor("negative")}
					bold
				/>
			</Show>

			<Show when={!props.loading && !props.error}>
				{/* Header: total file count and line statistics */}
				<box
					style={{
						width: "100%",
						height: 2,
						flexDirection: "column",
						paddingLeft: 1,
						paddingRight: 1,
					}}
				>
					<box style={{ flexDirection: "row" }}>
						<Show when={!hostNamesPage()}>
							<HighlightedText
								text="Changed Files"
								highlight="primary"
								attributes={TextAttributes.BOLD}
							/>
							<text> </text>
						</Show>
						<HighlightedText
							text={`(${totalStats().totalFiles} files)`}
							highlight="primary"
							attributes={TextAttributes.BOLD}
						/>
					</box>
					<text fg={highlightColor("secondary")}>
						<span style={{ fg: highlightColor("positive") }}>
							+{totalStats().totalAdded}
						</span>{" "}
						<span style={{ fg: highlightColor("negative") }}>
							-{totalStats().totalDeleted}
						</span>
					</text>
				</box>

				{/* Table header */}
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
					<box style={{ width: pathWidth() }}>
						<HighlightedText
							text="File Path"
							highlight="primary"
							attributes={TextAttributes.BOLD}
						/>
					</box>
					<box style={{ width: statsWidth() }}>
						<HighlightedText
							text="Changes (+/-)"
							highlight="primary"
							attributes={TextAttributes.BOLD}
						/>
					</box>
					<Show when={props.findings}>
						<box style={{ width: "12%" }}>
							<HighlightedText
								text="Findings"
								highlight="primary"
								attributes={TextAttributes.BOLD}
							/>
						</box>
					</Show>
				</SearchHeader>

				<FilterStatusBar
					filterSummary={props.filterSummary}
					sortSummary={props.sortSummary}
				/>

				<Show when={props.changes.length === 0}>
					<CenteredState
						message="No changed files"
						color={highlightColor("secondary")}
					/>
				</Show>

				<ScrollableList<ReviewChange>
					items={props.changes}
					selectedIndex={props.selectedIndex}
					{...(embedded()
						? { availableLines: props.availableLines }
						: { reservedLines: reservedLines() })}
					estimatedItemHeight={1}
					showScrollIndicator={false}
					renderItem={(change, isSelected) => {
						const changeType = getChangeType(change);
						const filePath = getFilePath(change);
						return (
							<box
								backgroundColor={isSelected() ? uiColors.bgSurface0 : undefined}
								style={{ width: "100%", height: 1, flexDirection: "row" }}
							>
								<box
									backgroundColor={
										isSelected() ? uiColors.highlight : undefined
									}
									style={{ width: 2, flexShrink: 0 }}
								/>
								<box
									style={{
										flexGrow: 1,
										width: 0,
										flexDirection: "row",
										paddingLeft: 1,
										paddingRight: 1,
									}}
								>
									<box style={{ width: 5 }}>
										<Badge
											text={changeType.type}
											highlight={changeType.highlight}
										/>
									</box>
									<box style={{ width: pathWidth() }}>
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
									<box style={{ width: statsWidth() }}>
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
									<Show when={props.findings}>
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
									</Show>
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
