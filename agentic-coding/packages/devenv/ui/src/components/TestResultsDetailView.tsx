/** @jsxImportSource @opentui/solid */

import type { TestCase, TestSuite } from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { createMemo, Show } from "solid-js";
import { uiColors } from "../colors";
import { Badge } from "./Badge";
import { CenteredState } from "./CenteredState";
import { ContentPanel } from "./ContentStack";
import { FilterStatusBar } from "./FilterStatusBar";
import { HighlightedText, highlightColor } from "./Highlight";
import { MatchedText } from "./MatchedText";
import { LAYOUT_CHROME_LINES, ScrollableList } from "./ScrollableList";
import { SearchHeader } from "./SearchHeader";

interface TestResultsDetailViewProps {
	testSuites?: TestSuite[];
	loading?: boolean;
	error?: string;
	selectedIndex: number;
	onClose: () => void;
	searchMode?: boolean;
	searchQuery?: string;
	filterSummary?: string;
	sortSummary?: string;
	testResultsUnsupported?: boolean;
}

/**
 * TestResultsDetailView Component - Shows all test results in table format
 * Failed tests are shown first, then sorted by class name
 * Uses the same table pattern as the application list
 * Navigation is handled by parent component
 */
export function TestResultsDetailView(props: TestResultsDetailViewProps) {
	// Sort all tests - failed/error first, then by class name, then by test name
	const sortedTests = createMemo(() => {
		if (!props.testSuites) return [];

		const allTests: Array<TestCase & { suiteName: string }> = [];

		for (const suite of props.testSuites) {
			for (const testCase of suite.test_cases) {
				allTests.push({
					...testCase,
					suiteName: suite.name,
				});
			}
		}

		// Sort: Failed/Error first, then by class name, then by test name
		return allTests.sort((a, b) => {
			const aIsFailed = a.status === "failed" || a.status === "error";
			const bIsFailed = b.status === "failed" || b.status === "error";

			// Failed tests come first
			if (aIsFailed && !bIsFailed) return -1;
			if (!aIsFailed && bIsFailed) return 1;

			// Within same status, sort by class name
			const classCompare = a.classname.localeCompare(b.classname);
			if (classCompare !== 0) return classCompare;

			// Within same class, sort by test name
			return a.name.localeCompare(b.name);
		});
	});

	// Filter sorted tests by search query
	const filteredTests = createMemo(() => {
		const q = (props.searchQuery ?? "").toLowerCase();
		if (!q) return sortedTests();
		return sortedTests().filter((t) =>
			[t.name, t.classname, t.suiteName, t.status].some((v) =>
				v?.toLowerCase().includes(q),
			),
		);
	});

	// Lines of fixed chrome outside the list area:
	//   Layout header (2) + Layout footer (3)    = LAYOUT_CHROME_LINES (5)
	//   Own paddingTop (1) + paddingBottom (1)   = 2
	//   Own header row + marginBottom            = 2
	//   Inner rounded border top + bottom        = 2
	//   Inner table header row                   = 1
	//                                     Total  = 13
	const hasFilterStatus = () => !!props.filterSummary || !!props.sortSummary;
	const reservedLines = () =>
		LAYOUT_CHROME_LINES + 2 + 2 + 2 + 1 + (hasFilterStatus() ? 1 : 0);

	// Format execution time
	const formatTime = (seconds: number) => {
		if (seconds < 1) {
			return `${Math.round(seconds * 1000)}ms`;
		}
		return `${seconds.toFixed(2)}s`;
	};

	return (
		<ContentPanel>
			{/* Header */}
			<box style={{ width: "100%", height: 1, marginBottom: 1 }}>
				<HighlightedText
					text="Test Results"
					highlight="primary"
					attributes={TextAttributes.BOLD}
				/>
			</box>

			<Show when={props.loading}>
				<CenteredState
					message="Loading test results..."
					color={highlightColor("highlight")}
					height={1}
				/>
			</Show>

			<Show when={!props.loading && props.error}>
				<CenteredState
					message={`Error: ${props.error}`}
					color={highlightColor("negative")}
					height={1}
				/>
			</Show>

			<Show
				when={
					!props.loading &&
					!props.error &&
					(!props.testSuites || props.testSuites.length === 0)
				}
			>
				<CenteredState
					message={
						props.testResultsUnsupported
							? "Test results are only available for GitLab CI"
							: "No test results available"
					}
					color={highlightColor("secondary")}
					height={1}
				/>
			</Show>

			{/* Test Results Table */}
			<Show when={!props.loading && !props.error && filteredTests().length > 0}>
				<box
					backgroundColor={uiColors.bgMantle}
					style={{
						width: "100%",
						flexGrow: 1,
						flexDirection: "column",
						overflow: "hidden",
					}}
				>
					{/* Table Header */}
					<SearchHeader
						searchMode={props.searchMode}
						searchQuery={props.searchQuery}
						resultCount={filteredTests().length}
					>
						<box style={{ width: "65%" }}>
							<HighlightedText
								text="Test Name"
								highlight="primary"
								attributes={TextAttributes.BOLD}
							/>
						</box>
						<box style={{ width: "15%" }}>
							<HighlightedText
								text="Time"
								highlight="primary"
								attributes={TextAttributes.BOLD}
							/>
						</box>
						<box style={{ width: "20%" }}>
							<HighlightedText
								text="Status"
								highlight="primary"
								attributes={TextAttributes.BOLD}
							/>
						</box>
					</SearchHeader>

					<FilterStatusBar
						filterSummary={props.filterSummary}
						sortSummary={props.sortSummary}
					/>

					{/* Table Body — rendered via ScrollableList */}
					<ScrollableList<TestCase & { suiteName: string }>
						items={filteredTests()}
						selectedIndex={props.selectedIndex}
						reservedLines={reservedLines()}
						estimatedItemHeight={1}
						showScrollIndicator={false}
						renderItem={(test, isSelected) => {
							const statusHighlight =
								test.status === "failed" || test.status === "error"
									? ("negative" as const)
									: test.status === "success"
										? ("positive" as const)
										: test.status === "skipped"
											? ("secondary" as const)
											: ("warning" as const);
							const testName = `${test.classname}.${test.name}`;
							return (
								<box
									backgroundColor={
										isSelected() ? uiColors.bgSurface0 : undefined
									}
									style={{
										width: "100%",
										height: 1,
										flexDirection: "row",
									}}
								>
									{/* Accent marker */}
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
										<box style={{ width: "65%" }}>
											<MatchedText
												text={testName}
												query={props.searchQuery}
												fg={highlightColor(
													isSelected() ? "primary" : "secondary",
												)}
											/>
										</box>
										<box style={{ width: "15%" }}>
											<text fg={highlightColor("secondary")}>
												{formatTime(test.execution_time)}
											</text>
										</box>
										<box style={{ width: "20%" }}>
											<Badge text={test.status} highlight={statusHighlight} />
										</box>
									</box>
								</box>
							);
						}}
					/>
				</box>
			</Show>
		</ContentPanel>
	);
}
