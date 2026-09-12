/** @jsxImportSource @opentui/solid */

import type { ChangeRequest, Issue, IssueComment } from "@devenv/types";
import type { ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, Show } from "solid-js";
import { uiColors } from "../colors";
import { getMarkdownSyntaxStyle } from "../markdownSyntax";
import { containsHtml, gitlabHtmlToMarkdown } from "../utils/gitlabHtml";
import { AnimatedStatusText } from "./AnimatedStatusText";
import { ContentFrame } from "./ContentStack";
import { DetailSection } from "./DetailSection";
import { highlightForIndex } from "./Highlight";
import {
	PropertiesList,
	type PropertyRow,
	propertyBadges,
} from "./PropertiesList";
import { RunningText } from "./RunningText";
import { ScrollableContent } from "./ScrollableContent";

type RefItem =
	| { type: "cr"; data: ChangeRequest }
	| { type: "issue"; data: Issue };

interface IssueDetailViewProps {
	issue: Issue;
	comments: IssueComment[];
	issueCommentsLoading: boolean;
	error: string;
	linkedChangeRequests?: ChangeRequest[];
	linkedChangeRequestsLoading?: boolean;
	linkedChangeRequestsError?: string;
	referencedIssues?: Issue[];
	referencedIssuesLoading?: boolean;
	referencedIssuesError?: string;
	references?: RefItem[];
	onDetailScrollBoxReady?: (scrollBox: ScrollBoxRenderable) => void;
	onCommentsScrollBoxReady?: (scrollBox: ScrollBoxRenderable) => void;
	runningTextEnabled?: boolean;
	runningTextOffset?: number;
	activePanelIndex?: number;
}

/**
 * IssueDetailView Component - Shows detailed issue information
 */
export function IssueDetailView(props: IssueDetailViewProps) {
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

	const dimensions = useTerminalDimensions();
	const issue = () => props.issue;
	const lineWidth = () => Math.max(1, dimensions().width - 4);
	const referenceTitleWidth = () => Math.max(1, lineWidth() - 8);
	const metadataRows = (): PropertyRow[] => {
		const rows: PropertyRow[] = [
			{
				label: "State",
				value: propertyBadges([
					{
						label: issue().state,
						highlight:
							issue().state === "open" || issue().state === "opened"
								? "positive"
								: "secondary",
					},
				]),
			},
		];

		if ((issue().labels ?? []).length > 0) {
			rows.push({
				label: "Labels",
				value: propertyBadges(
					(issue().labels ?? []).map((label, index) => ({
						label,
						highlight: highlightForIndex(index),
					})),
				),
			});
		}

		rows.push({
			label: "Assignees",
			value: propertyBadges(
				(issue().assignees ?? []).length > 0
					? (issue().assignees ?? []).map((assignee) => ({
							label: assignee.name,
							highlight: "primary",
						}))
					: [{ label: "unassigned", highlight: "secondary" }],
			),
		});

		const milestoneTitle = issue().milestone?.title;
		if (milestoneTitle)
			rows.push({ label: "Milestone", value: milestoneTitle });
		if (issue().updated_at)
			rows.push({ label: "Updated", value: formatDate(issue().updated_at) });
		if (issue().created_at)
			rows.push({ label: "Created", value: formatDate(issue().created_at) });
		if (issue().author?.name)
			rows.push({
				label: "Author",
				value: issue().author.name,
				valueHighlight: "secondary",
			});

		const description = issue().description;
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

		if (issue().web_url) {
			rows.push({
				label: "URL",
				value: (
					<RunningText
						text={issue().web_url}
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
				style={{
					width: "100%",
					flexGrow: 1,
					minHeight: 0,
					flexDirection: "column",
					gap: 0,
				}}
			>
				{/* METADATA PANEL (panel 0) */}
				<DetailSection
					active={props.activePanelIndex === 0}
					header={
						<RunningText
							text={issue().title}
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
					<ScrollableContent
						onScrollBoxReady={(r) => props.onDetailScrollBoxReady?.(r)}
						style={{
							width: "100%",
							flexGrow: 1,
							minHeight: 0,
						}}
					>
						<PropertiesList rows={metadataRows()} labelWidth={12} />
					</ScrollableContent>
				</DetailSection>

				<box style={{ width: "100%", height: 1, flexShrink: 0 }} />

				{/* REFERENCES PANEL (panel 1) */}
				<DetailSection
					active={props.activePanelIndex === 1}
					title={`References${props.references && props.references.length > 0 ? ` (${props.references.length})` : ""}`}
					style={{
						width: "100%",
						flexGrow: 0,
						flexShrink: 0,
						maxHeight: 7,
						flexDirection: "column",
						overflow: "hidden",
					}}
				>
					<Show
						when={
							props.linkedChangeRequestsLoading || props.referencedIssuesLoading
						}
					>
						<box style={{ paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
							<AnimatedStatusText
								text="Loading references…"
								intent="load"
								backgroundColor={uiColors.bgMantle}
							/>
						</box>
					</Show>

					<Show
						when={
							!props.linkedChangeRequestsLoading &&
							!props.referencedIssuesLoading &&
							(!props.references || props.references.length === 0)
						}
					>
						<box style={{ paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
							<text fg={uiColors.textMuted}>No references</text>
						</box>
					</Show>

					<Show when={props.references && props.references.length > 0}>
						<ScrollableContent
							style={{
								width: "100%",
								maxHeight: 6,
							}}
						>
							<For each={props.references?.slice(0, 3)}>
								{(ref) => (
									<box
										style={{
											flexDirection: "row",
											paddingLeft: 1,
											paddingRight: 1,
										}}
									>
										<text
											fg={
												ref.type === "cr"
													? uiColors.primary
													: uiColors.textSecondary
											}
										>
											{ref.type === "cr" ? "!" : "#"}
											{ref.data.iid}
										</text>
										<text fg={uiColors.textSecondary}>
											{ref.data.state === "opened" || ref.data.state === "open"
												? " ○ "
												: ref.data.state === "merged"
													? " ● "
													: " ◌ "}
										</text>
										<RunningText
											text={ref.data.title}
											width={referenceTitleWidth()}
											fg={uiColors.textSecondary}
											enabled={props.runningTextEnabled}
											active
											offset={props.runningTextOffset}
										/>
									</box>
								)}
							</For>
							<Show when={(props.references?.length ?? 0) > 3}>
								<box
									style={{
										flexDirection: "row",
										paddingLeft: 1,
										paddingRight: 1,
									}}
								>
									<text fg={uiColors.primary}>
										View all {props.references?.length} →
									</text>
								</box>
							</Show>
						</ScrollableContent>
					</Show>
				</DetailSection>

				<box style={{ width: "100%", height: 1, flexShrink: 0 }} />

				{/* COMMENTS PANEL (panel 2) */}
				<DetailSection
					active={props.activePanelIndex === 2}
					title={`Comments${props.comments.length > 0 ? ` (${props.comments.length})` : ""}`}
					style={{
						width: "100%",
						flexGrow: 0,
						flexShrink: 0,
						maxHeight: 6,
						flexDirection: "column",
						overflow: "hidden",
					}}
				>
					<Show when={props.issueCommentsLoading}>
						<box style={{ paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
							<AnimatedStatusText
								text="Loading comments…"
								intent="load"
								backgroundColor={uiColors.bgMantle}
							/>
						</box>
					</Show>

					<Show when={!props.issueCommentsLoading && props.error}>
						<box style={{ paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
							<text fg={uiColors.error}>Error: {props.error}</text>
						</box>
					</Show>

					<Show
						when={
							!props.issueCommentsLoading &&
							!props.error &&
							props.comments.length === 0
						}
					>
						<box style={{ paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
							<text fg={uiColors.textMuted}>No comments</text>
						</box>
					</Show>

					<Show when={!props.issueCommentsLoading && props.comments.length > 0}>
						<ScrollableContent
							onScrollBoxReady={props.onCommentsScrollBoxReady}
							style={{
								width: "100%",
								maxHeight: 3,
							}}
						>
							<For each={props.comments.slice(-3)}>
								{(comment) => (
									<box
										style={{
											flexDirection: "row",
											paddingLeft: 1,
											paddingRight: 1,
										}}
									>
										<text fg={uiColors.primary}>{comment.author.name}</text>
										<text fg={uiColors.textMuted}>
											{" "}
											{formatDate(comment.created_at)}
										</text>
										<Show when={comment.system}>
											<text fg={uiColors.textSecondary}> (system)</text>
										</Show>
										<text>{": "}</text>
										<RunningText
											text={comment.body}
											width={100}
											enabled={props.runningTextEnabled}
											active
											offset={props.runningTextOffset}
										/>
									</box>
								)}
							</For>
						</ScrollableContent>
					</Show>
				</DetailSection>
			</box>
		</ContentFrame>
	);
}
