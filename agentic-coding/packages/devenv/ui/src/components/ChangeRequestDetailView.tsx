/** @jsxImportSource @opentui/solid */

import type {
	ChangeRequest,
	ChangeRequestChange,
	Discussion,
	Issue,
	Job,
	TestSummary,
} from "@devenv/types";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, For, Show } from "solid-js";
import { uiColors } from "../colors";
import { getMarkdownSyntaxStyle } from "../markdownSyntax";
import { containsHtml, gitlabHtmlToMarkdown } from "../utils/gitlabHtml";
import { ContentFrame } from "./ContentStack";
import { DetailSection } from "./DetailSection";
import { HighlightedText } from "./Highlight";
import {
	PropertiesList,
	type PropertyRow,
	propertyBadges,
} from "./PropertiesList";
import { RunningText } from "./RunningText";
import { ScrollableContent } from "./ScrollableContent";

interface ChangeRequestDetailViewProps {
	changeRequest: ChangeRequest;
	jobs?: Job[];
	jobsLoading?: boolean;
	testSummary?: TestSummary;
	testLoading?: boolean;
	testError?: string;
	testResultsUnsupported?: boolean;
	changes?: ChangeRequestChange[];
	changesLoading?: boolean;
	changesError?: string;
	discussions?: Discussion[];
	discussionsLoading?: boolean;
	discussionsError?: string;
	linkedIssues?: Issue[];
	linkedIssuesLoading?: boolean;
	linkedIssuesError?: string;
	runningTextEnabled?: boolean;
	runningTextOffset?: number;
	onClose: () => void;
	activePanelIndex?: number;
	onMetadataScrollBoxReady?: (
		ref: import("@opentui/core").ScrollBoxRenderable,
	) => void;
	onChangedFilesScrollBoxReady?: (
		ref: import("@opentui/core").ScrollBoxRenderable,
	) => void;
	onPipelineJobsScrollBoxReady?: (
		ref: import("@opentui/core").ScrollBoxRenderable,
	) => void;
}

/**
 * ChangeRequestDetailView Component - Shows detailed CR information
 * Layout: 3 left panels (Metadata, Status, Changed Files) + 2 right panels (Jobs, Tests)
 * Matches the Go TUI version structure
 */
export function ChangeRequestDetailView(props: ChangeRequestDetailViewProps) {
	// Format date
	const formatDate = (dateStr: string) => {
		const date = new Date(dateStr);
		return date.toLocaleDateString("en-US", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	};

	// Get status color
	const getStatusColor = (status: string) => {
		switch (status.toLowerCase()) {
			case "success":
			case "can_be_merged":
			case "opened":
				return uiColors.success;
			case "failed":
			case "cannot_be_merged":
				return uiColors.error;
			case "running":
			case "checking":
				return uiColors.primary;
			case "pending":
			case "created":
				return uiColors.warning;
			case "merged":
				return uiColors.primary;
			case "closed":
			case "skipped":
			case "canceled":
				return uiColors.textMuted;
			case "manual":
				return uiColors.warning;
			default:
				return uiColors.textSecondary;
		}
	};

	// Group jobs by stage and sort stages by the minimum job ID in each stage
	// This ensures stages appear in the order they were defined in the pipeline
	const jobsByStage = createMemo(() => {
		if (!props.jobs) return new Map<string, Job[]>();

		// Group jobs by stage
		const grouped = new Map<string, Job[]>();
		const stageMinJobId = new Map<string, number>();

		for (const job of props.jobs) {
			const stage = (job.stage ?? "").trim() || "Default";
			if (!grouped.has(stage)) {
				grouped.set(stage, []);
				stageMinJobId.set(stage, job.id);
			}
			grouped.get(stage)?.push(job);

			// Track the minimum job ID for this stage
			const currentMin = stageMinJobId.get(stage);
			if (currentMin !== undefined && job.id < currentMin) {
				stageMinJobId.set(stage, job.id);
			}
		}

		// Sort stages by their minimum job ID (execution order)
		const sortedStages = Array.from(grouped.keys()).sort((a, b) => {
			return (stageMinJobId.get(a) ?? 0) - (stageMinJobId.get(b) ?? 0);
		});

		// Create a new Map with sorted stages
		const sortedGrouped = new Map<string, Job[]>();
		for (const stage of sortedStages) {
			const jobs = grouped.get(stage);
			if (jobs) sortedGrouped.set(stage, jobs);
		}

		return sortedGrouped;
	});

	// Count discussions by resolved status
	const discussionCounts = createMemo(() => {
		if (!props.discussions || props.discussions.length === 0) {
			return { total: 0, resolved: 0, open: 0 };
		}

		const total = props.discussions.length;
		const resolved = props.discussions.filter(
			(d) => d.notes[0]?.resolved,
		).length;
		const open = total - resolved;

		return { total, resolved, open };
	});
	const discussionsPanelHeight = () =>
		!props.discussionsLoading &&
		!props.discussionsError &&
		discussionCounts().total > 0
			? 4
			: 2;
	const testResultsPanelHeight = () => {
		if (props.testLoading || props.testError || !props.testSummary) return 2;
		return props.testSummary.error > 0 ? 6 : 5;
	};

	const dimensions = useTerminalDimensions();
	const cr = () => props.changeRequest;
	const lineWidth = () => Math.max(1, Math.floor(dimensions().width * 0.6) - 4);
	const linkedIssueTitleWidth = () =>
		Math.max(1, Math.floor(dimensions().width * 0.4) - 20);
	const statusHighlight = (status: string) => {
		switch (status.toLowerCase()) {
			case "success":
			case "can_be_merged":
			case "opened":
				return "positive" as const;
			case "failed":
			case "cannot_be_merged":
				return "negative" as const;
			case "pending":
			case "created":
			case "manual":
				return "warning" as const;
			case "running":
			case "checking":
			case "merged":
				return "highlight" as const;
			case "closed":
			case "skipped":
			case "canceled":
				return "secondary" as const;
			default:
				return "primary" as const;
		}
	};
	const isDefaultTargetBranch = () =>
		!!cr().default_branch && cr().target_branch === cr().default_branch;
	const mergeHighlight = () => {
		if (cr().merge_status === "can_be_merged") return "positive" as const;
		if (
			cr().merge_status === "cannot_be_merged" ||
			cr().merge_status === "cannot_be_merged_recheck"
		)
			return "negative" as const;
		return "warning" as const;
	};
	const mergeLabel = () => {
		if (cr().merge_status === "can_be_merged") return "Can be merged";
		if (
			cr().merge_status === "cannot_be_merged" ||
			cr().merge_status === "cannot_be_merged_recheck"
		)
			return "Cannot be merged";
		return cr().merge_status || "unknown";
	};
	const statusRows = (): PropertyRow[] => {
		const rows: PropertyRow[] = [
			{
				label: "Merge",
				value: propertyBadges([
					{ label: mergeLabel(), highlight: mergeHighlight() },
				]),
			},
		];

		if (
			cr().detailed_merge_status &&
			cr().detailed_merge_status !== cr().merge_status
		) {
			rows.push({
				label: "Details",
				value: cr().detailed_merge_status,
				valueHighlight: "secondary",
			});
		}
		if (cr().draft || cr().work_in_progress)
			rows.push({ label: "Draft", value: "Yes", valueHighlight: "warning" });
		if (cr().has_conflicts)
			rows.push({
				label: "Conflicts",
				value: "Yes",
				valueHighlight: "negative",
			});
		if (!cr().blocking_discussions_resolved)
			rows.push({
				label: "Discussions",
				value: "Unresolved",
				valueHighlight: "warning",
			});
		const approvals = cr().approvals;
		if (approvals) {
			const approved = approvals.approvals_left === 0;
			const approvedCount =
				approvals.approvals_required - approvals.approvals_left;
			rows.push({
				label: "Approvals",
				value: approved
					? `Approved ${approvedCount}/${approvals.approvals_required}`
					: `${approvedCount}/${approvals.approvals_required} need ${approvals.approvals_left}`,
				valueHighlight: approved ? "positive" : "warning",
			});
			if (approvals.approved_by?.length > 0) {
				rows.push({
					label: "Approved By",
					value: approvals.approved_by
						.map((approval) => approval.user.name)
						.join(", "),
					valueHighlight: "secondary",
				});
			}
		}
		if (cr().rebase_in_progress)
			rows.push({
				label: "Rebase",
				value: "In progress",
				valueHighlight: "warning",
			});

		return rows;
	};
	const metadataRows = (): PropertyRow[] => {
		const rows: PropertyRow[] = [
			{
				label: "State",
				value: propertyBadges([
					{ label: cr().state, highlight: statusHighlight(cr().state) },
				]),
			},
		];

		const pipelineStatus = cr().head_pipeline?.status;
		if (pipelineStatus) {
			rows.push({
				label: "Pipeline",
				value: propertyBadges([
					{ label: pipelineStatus, highlight: statusHighlight(pipelineStatus) },
				]),
			});
		}

		rows.push({ label: "Source", value: cr().source_branch });
		if (!isDefaultTargetBranch()) {
			rows.push({
				label: "Target",
				value: propertyBadges([
					{ label: cr().target_branch, highlight: "warning" },
				]),
			});
		}

		if (cr().updated_at)
			rows.push({ label: "Updated", value: formatDate(cr().updated_at) });
		if (cr().created_at)
			rows.push({ label: "Created", value: formatDate(cr().created_at) });
		if (cr().author?.name)
			rows.push({
				label: "Author",
				value: `${cr().author.name} (@${cr().author.username})`,
				valueHighlight: "secondary",
			});

		const description = cr().description;
		if (description && description.trim() !== "") {
			rows.push({
				label: "Description",
				layout: "block",
				value: (
					<code
						filetype="markdown"
						content={
							containsHtml(description)
								? gitlabHtmlToMarkdown(description)
								: description
						}
						syntaxStyle={getMarkdownSyntaxStyle()}
						drawUnstyledText={true}
						fg={uiColors.textSecondary}
					/>
				),
			});
		}

		if (cr().web_url) {
			rows.push({
				label: "URL",
				value: (
					<RunningText
						text={cr().web_url}
						width={lineWidth()}
						fg={uiColors.textMuted}
						enabled={props.runningTextEnabled}
						active
						offset={props.runningTextOffset}
					/>
				),
				labelHighlight: "secondary",
			});
		}

		return rows;
	};

	return (
		<ContentFrame>
			<box
				backgroundColor={uiColors.bgBase}
				style={{
					width: "100%",
					flexGrow: 1,
					minHeight: 0,
					flexDirection: "row",
				}}
			>
				<box
					backgroundColor={uiColors.bgBase}
					style={{
						width: "60%",
						height: "100%",
						flexDirection: "column",
					}}
				>
					{/* METADATA PANEL (panel 0) */}
					<DetailSection
						active={props.activePanelIndex === 0}
						header={
							<RunningText
								text={cr().title}
								width={lineWidth()}
								fg={uiColors.textPrimary}
								attributes={TextAttributes.BOLD}
								enabled={props.runningTextEnabled}
								active
								offset={props.runningTextOffset}
							/>
						}
						style={{
							width: "100%",
							flexGrow: 1,
							flexBasis: 0,
							flexDirection: "column",
							overflow: "hidden",
						}}
					>
						{/* Scrollable content */}
						<ScrollableContent
							onScrollBoxReady={props.onMetadataScrollBoxReady}
							style={{
								width: "100%",
								flexGrow: 1,
								minHeight: 0,
							}}
						>
							<PropertiesList rows={metadataRows()} labelWidth={12} />
						</ScrollableContent>
					</DetailSection>

					<box
						style={{ width: "100%", height: 1, flexShrink: 0 }}
						backgroundColor={uiColors.bgBase}
					/>

					{/* STATUS PANEL (panel 1) */}
					<DetailSection
						active={props.activePanelIndex === 1}
						title="Status"
						style={{
							width: "100%",
							height: statusRows().length + 1,
							flexShrink: 0,
							flexDirection: "column",
							overflow: "hidden",
						}}
					>
						<PropertiesList rows={statusRows()} labelWidth={12} />
					</DetailSection>

					<box
						style={{ width: "100%", height: 1, flexShrink: 0 }}
						backgroundColor={uiColors.bgBase}
					/>

					{/* CHANGED FILES PANEL (panel 2) */}
					<DetailSection
						active={props.activePanelIndex === 2}
						title="Changed Files"
						style={{
							width: "100%",
							flexGrow: 1,
							flexBasis: 0,
							flexDirection: "column",
							overflow: "hidden",
						}}
					>
						<box
							style={{ width: "100%", flexShrink: 0, flexDirection: "column" }}
						>
							{/* Loading State */}
							<Show when={props.changesLoading}>
								<box
									style={{ width: "100%", height: 1 }}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.warning}>Loading changed files...</text>
								</box>
							</Show>

							{/* Error State */}
							<Show when={!props.changesLoading && props.changesError}>
								<box
									style={{ width: "100%", height: 1 }}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.error}>Error: {props.changesError}</text>
								</box>
							</Show>

							{/* Empty State */}
							<Show
								when={
									!props.changesLoading &&
									!props.changesError &&
									(!props.changes || props.changes.length === 0)
								}
							>
								<box
									style={{ width: "100%", height: 1 }}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.textMuted}>No changed files</text>
								</box>
							</Show>
						</box>

						{/* Changed Files List */}
						<Show
							when={
								!props.changesLoading &&
								!props.changesError &&
								props.changes &&
								props.changes.length > 0
							}
						>
							<ScrollableContent
								onScrollBoxReady={props.onChangedFilesScrollBoxReady}
								style={{ flexGrow: 1, minHeight: 0 }}
							>
								<For each={props.changes}>
									{(change) => {
										let icon = "~";
										let color: string = uiColors.primary;
										let path = change.new_path;

										if (change.new_file) {
											icon = "+";
											color = uiColors.success as string;
										} else if (change.deleted_file) {
											icon = "-";
											color = uiColors.error as string;
											path = change.old_path;
										} else if (change.renamed_file) {
											icon = "→";
											color = uiColors.warning as string;
											path = `${change.old_path} → ${change.new_path}`;
										}

										return (
											<box
												style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}
											>
												<text fg={color}>
													{icon} {path}
												</text>
											</box>
										);
									}}
								</For>
							</ScrollableContent>
						</Show>
					</DetailSection>
				</box>

				{/* RIGHT COLUMN: Pipeline Jobs + Test Results */}
				<box
					style={{ width: 1, flexShrink: 0 }}
					backgroundColor={uiColors.bgBase}
				/>
				<box
					backgroundColor={uiColors.bgBase}
					style={{
						width: "40%",
						height: "100%",
						flexDirection: "column",
					}}
				>
					{/* PIPELINE JOBS PANEL (panel 3) */}
					<DetailSection
						active={props.activePanelIndex === 3}
						title="Pipeline Jobs"
						style={{
							width: "100%",
							flexGrow: 1,
							flexDirection: "column",
							overflow: "hidden",
						}}
					>
						<box
							style={{ width: "100%", flexShrink: 0, flexDirection: "column" }}
						>
							{/* Loading State */}
							<Show when={props.jobsLoading}>
								<box
									style={{ width: "100%", height: 1 }}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.warning}>Loading jobs...</text>
								</box>
							</Show>

							{/* No Pipeline */}
							<Show when={!props.jobsLoading && !cr().head_pipeline}>
								<box
									style={{ width: "100%", height: 1 }}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.textMuted}>No pipeline available</text>
								</box>
							</Show>

							{/* Empty Jobs */}
							<Show
								when={
									!props.jobsLoading &&
									cr().head_pipeline &&
									cr().head_pipeline?.id &&
									(!props.jobs || props.jobs.length === 0)
								}
							>
								<box
									style={{ width: "100%", height: 1 }}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.textMuted}>No jobs found</text>
								</box>
							</Show>
						</box>

						{/* Jobs by Stage */}
						<Show
							when={!props.jobsLoading && props.jobs && props.jobs.length > 0}
						>
							<ScrollableContent
								onScrollBoxReady={props.onPipelineJobsScrollBoxReady}
								style={{ flexGrow: 1, minHeight: 0 }}
							>
								<For each={Array.from(jobsByStage().entries())}>
									{([stage, jobs]) => (
										<>
											{/* Stage Header */}
											<box
												style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}
											>
												<text
													fg={uiColors.textMuted}
													attributes={TextAttributes.BOLD}
												>
													{stage}:
												</text>
											</box>

											{/* Jobs in Stage */}
											<For each={jobs}>
												{(job) => (
													<box
														style={{
															height: 1,
															paddingLeft: 2,
															paddingRight: 1,
														}}
													>
														<text fg={getStatusColor(job.status)}>
															{job.status === "success"
																? "✓"
																: job.status === "failed"
																	? "✗"
																	: job.status === "running"
																		? "▶"
																		: job.status === "pending"
																			? "○"
																			: job.status === "manual"
																				? "◎"
																				: "○"}{" "}
															{job.name}
														</text>
													</box>
												)}
											</For>
										</>
									)}
								</For>
							</ScrollableContent>
						</Show>
					</DetailSection>

					<box
						style={{ width: "100%", height: 1, flexShrink: 0 }}
						backgroundColor={uiColors.bgBase}
					/>

					{/* LINKED ISSUES PANEL (panel 4) */}
					<DetailSection
						active={props.activePanelIndex === 4}
						title={`Linked Issues${props.linkedIssues && props.linkedIssues.length > 0 ? ` (${props.linkedIssues.length})` : ""}`}
						style={{
							width: "100%",
							height: 3,
							flexShrink: 0,
							flexDirection: "column",
						}}
					>
						<Show when={props.linkedIssuesLoading}>
							<box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
								<text fg={uiColors.warning}>Loading...</text>
							</box>
						</Show>

						<Show
							when={
								!props.linkedIssuesLoading &&
								props.linkedIssuesError &&
								props.linkedIssuesError.length > 0
							}
						>
							<box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
								<text fg={uiColors.error}>
									Error: {props.linkedIssuesError}
								</text>
							</box>
						</Show>

						<Show
							when={
								!props.linkedIssuesLoading &&
								!props.linkedIssuesError &&
								(!props.linkedIssues || props.linkedIssues.length === 0)
							}
						>
							<box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
								<text fg={uiColors.textMuted}>No linked issues</text>
							</box>
						</Show>

						<Show
							when={
								!props.linkedIssuesLoading &&
								!props.linkedIssuesError &&
								(props.linkedIssues?.length ?? 0) > 0
							}
						>
							<For each={(props.linkedIssues ?? []).slice(0, 2)}>
								{(iss) => (
									<box
										style={{
											width: "100%",
											height: 1,
											flexDirection: "row",
											paddingLeft: 1,
											paddingRight: 1,
										}}
									>
										<box style={{ width: 8, flexShrink: 0 }}>
											<text fg={uiColors.primary}>{`#${iss.iid}`}</text>
										</box>
										<box style={{ width: 10, flexShrink: 0 }}>
											<HighlightedText
												text={iss.state}
												highlight={
													iss.state === "opened" || iss.state === "open"
														? "positive"
														: "secondary"
												}
											/>
										</box>
										<box style={{ flexGrow: 1, minWidth: 0 }}>
											<RunningText
												text={iss.title}
												width={linkedIssueTitleWidth()}
												fg={uiColors.textSecondary}
												enabled={props.runningTextEnabled}
												active
												offset={props.runningTextOffset}
											/>
										</box>
									</box>
								)}
							</For>
						</Show>
					</DetailSection>

					<box
						style={{ width: "100%", height: 1, flexShrink: 0 }}
						backgroundColor={uiColors.bgBase}
					/>

					{/* DISCUSSIONS PANEL (panel 5) */}
					<DetailSection
						active={props.activePanelIndex === 5}
						title="Discussions"
						style={{
							width: "100%",
							height: discussionsPanelHeight(),
							flexShrink: 0,
							flexDirection: "column",
						}}
					>
						<box
							style={{ width: "100%", flexShrink: 0, flexDirection: "column" }}
						>
							{/* Loading State */}
							<Show when={props.discussionsLoading}>
								<box
									style={{ width: "100%", height: 1 }}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.warning}>Loading discussions...</text>
								</box>
							</Show>

							{/* Error State */}
							<Show when={!props.discussionsLoading && props.discussionsError}>
								<box
									style={{ width: "100%", height: 1 }}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.textMuted}>{props.discussionsError}</text>
								</box>
							</Show>

							{/* No Discussions */}
							<Show
								when={
									!props.discussionsLoading &&
									!props.discussionsError &&
									discussionCounts().total === 0
								}
							>
								<box
									style={{ width: "100%", height: 1 }}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.textMuted}>No discussions</text>
								</box>
							</Show>

							{/* Discussion Summary */}
							<Show
								when={!props.discussionsLoading && discussionCounts().total > 0}
							>
								<box
									style={{ width: "100%", flexDirection: "column" }}
									paddingLeft={1}
									paddingRight={1}
									paddingBottom={0}
								>
									<box
										style={{ width: "100%", height: 1, flexDirection: "row" }}
									>
										<text
											fg={uiColors.textMuted}
											attributes={TextAttributes.BOLD}
										>
											Total:{" "}
										</text>
										<text fg={uiColors.textSecondary}>
											{discussionCounts().total}
										</text>
									</box>

									<box
										style={{ width: "100%", height: 1, flexDirection: "row" }}
									>
										<text
											fg={uiColors.textMuted}
											attributes={TextAttributes.BOLD}
										>
											Open:{" "}
										</text>
										<text
											fg={
												discussionCounts().open > 0
													? uiColors.warning
													: uiColors.success
											}
										>
											{discussionCounts().open}
										</text>
									</box>

									<box
										style={{ width: "100%", height: 1, flexDirection: "row" }}
									>
										<text
											fg={uiColors.textMuted}
											attributes={TextAttributes.BOLD}
										>
											Resolved:{" "}
										</text>
										<text fg={uiColors.success}>
											{discussionCounts().resolved}
										</text>
									</box>
								</box>
							</Show>
						</box>
					</DetailSection>

					<box
						style={{ width: "100%", height: 1, flexShrink: 0 }}
						backgroundColor={uiColors.bgBase}
					/>

					{/* TEST RESULTS PANEL (panel 6) */}
					<DetailSection
						active={props.activePanelIndex === 6}
						title="Test Results"
						style={{
							width: "100%",
							height: testResultsPanelHeight(),
							flexShrink: 0,
							flexDirection: "column",
						}}
					>
						<box
							style={{ width: "100%", flexShrink: 0, flexDirection: "column" }}
						>
							{/* Loading State */}
							<Show when={props.testLoading}>
								<box
									style={{ width: "100%", height: 1 }}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.warning}>Loading tests...</text>
								</box>
							</Show>

							{/* Error State */}
							<Show when={!props.testLoading && props.testError}>
								<box
									style={{ width: "100%", height: 1 }}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.textMuted}>{props.testError}</text>
								</box>
							</Show>

							{/* No Tests */}
							<Show
								when={
									!props.testLoading && !props.testError && !props.testSummary
								}
							>
								<box
									style={{ width: "100%", height: 1 }}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.textSecondary}>
										{props.testResultsUnsupported
											? "Test results are only available for GitLab CI"
											: "No test results available"}
									</text>
								</box>
							</Show>

							{/* Test Summary */}
							<Show when={!props.testLoading && props.testSummary}>
								<box
									style={{ width: "100%", flexDirection: "column" }}
									paddingLeft={1}
									paddingRight={1}
									paddingBottom={0}
								>
									<box
										style={{ width: "100%", height: 1, flexDirection: "row" }}
									>
										<text
											fg={uiColors.textMuted}
											attributes={TextAttributes.BOLD}
										>
											Total:{" "}
										</text>
										<text fg={uiColors.textSecondary}>
											{props.testSummary?.total}
										</text>
									</box>

									<box
										style={{ width: "100%", height: 1, flexDirection: "row" }}
									>
										<text
											fg={uiColors.textMuted}
											attributes={TextAttributes.BOLD}
										>
											Success:{" "}
										</text>
										<text fg={uiColors.success}>
											{props.testSummary?.success}
										</text>
									</box>

									<box
										style={{ width: "100%", height: 1, flexDirection: "row" }}
									>
										<text
											fg={uiColors.textMuted}
											attributes={TextAttributes.BOLD}
										>
											Failed:{" "}
										</text>
										<text fg={uiColors.error}>{props.testSummary?.failed}</text>
									</box>

									<box
										style={{ width: "100%", height: 1, flexDirection: "row" }}
									>
										<text
											fg={uiColors.textMuted}
											attributes={TextAttributes.BOLD}
										>
											Skipped:{" "}
										</text>
										<text fg={uiColors.textMuted}>
											{props.testSummary?.skipped}
										</text>
									</box>

									<Show when={(props.testSummary?.error ?? 0) > 0}>
										<box
											style={{
												width: "100%",
												height: 1,
												flexDirection: "row",
												paddingBottom: 1,
											}}
										>
											<text
												fg={uiColors.textMuted}
												attributes={TextAttributes.BOLD}
											>
												Error:{" "}
											</text>
											<text fg={uiColors.error}>
												{props.testSummary?.error}
											</text>
										</box>
									</Show>
								</box>
							</Show>
						</box>
					</DetailSection>
				</box>
			</box>
		</ContentFrame>
	);
}
