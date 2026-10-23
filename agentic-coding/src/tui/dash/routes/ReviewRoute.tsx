/** Review route (establish-opencode-boundaries, task 6.1).
 *
 * The three review presentations — changed-file list, diff, plan/wiki markdown —
 * as one route module. Props-in: the review feature owns its state and actions,
 * the route only decides what is visible and hands key ownership back to the
 * shell. */

import type { Keybind } from "@ui";
import {
	ChangedFilesView,
	DiffReviewView as DiffViewModal,
	GenericModal,
	MarkdownReviewView as MarkdownViewModal,
	useModalBackdrop,
} from "@ui";
import { Show } from "solid-js";
import type { createReviewFeature } from "../review.ts";

export interface ReviewRouteProps {
	readonly feature: ReturnType<typeof createReviewFeature>;
	/** The shell's modal host top kind, so a review only owns keys when on top. */
	readonly modalTop: () => string | undefined;
	/** Hand key ownership back to the shell when the route closes a dialog. */
	readonly setModalActive: (modal: string) => void;
	/** Title fallback when no user action names the review. */
	readonly fallbackTitle?: string;
	/** Shared dashboard catalog entries for the stage report review surface. */
	readonly stageReportKeybinds?: readonly Keybind[];
	/** The stage-test plan gate's own catalog (USAB-003). */
	readonly stagePlanKeybinds?: readonly Keybind[];
}

export function ReviewRoute(props: ReviewRouteProps) {
	// A backdrop tap is this dialog's own `Esc`, so the review's ladder decides:
	// the search box first, then an applied query, then the diff view, and only
	// last the postpone. A direct close would discard the developer's filter.
	const reviewFilesBackdrop = useModalBackdrop({ kind: "review-files" });
	const {
		developerReviewPhase,
		reviewOpen,
		reviewKind,
		stageWikiUpdateAvailable,
		stagePlanReview,
		reviewView,
		setReviewOpen,
		setReviewView,
		reviewChangeIndex,
		reviewLine,
		setReviewLine,
		reviewDiff,
		reviewCommentMode,
		setReviewCommentMode,
		reviewCommentText,
		reviewVisualMode,
		setReviewVisualMode,
		reviewVisualStart,
		setReviewSourceRange,
		setReviewDiscussionLineIndices,
		setReviewSelectableLineCount,
		reviewSearchMode,
		reviewSearchQuery,
		reviewVisibleChanges,
		reviewFile,
		reviewChangesForView,
		reviewFilesAvailableLines,
		currentReviewDiscussions,
		navigatePlanMarkdownFile,
		reviewSplitView,
		reviewDiscussions,
		setReviewSelectedLineFindingIds,
		navigateReviewFile,
		reviewDiffFile,
	} = props.feature;
	return (
		<>
			<Show
				when={
					reviewOpen() &&
					props.modalTop() === "review" &&
					reviewView() === "files"
				}
			>
				<GenericModal
					title={
						reviewKind() === "plan"
							? "Plan review"
							: reviewKind() === "wiki"
								? "Wiki review"
								: reviewKind() === "setup"
									? "Environment review"
									: reviewKind() === "stage"
										? "Stage test report"
										: (props.fallbackTitle ?? "Developer review")
					}
					widthPercent={0.9}
					heightPercent={0.75}
					helpText={
						reviewKind() === "stage" && props.stageReportKeybinds
							? props.stageReportKeybinds
							: [
									{ key: "j/k", action: "Navigate" },
									{
										key: "Enter",
										action:
											reviewKind() === "plan"
												? "Open artifact"
												: reviewKind() === "wiki"
													? "Open document"
													: reviewKind() === "stage"
														? "Read report"
														: "Open diff",
									},
									{ key: "/", action: "Search files" },
									...(reviewKind() === "plan" ||
									reviewKind() === "wiki" ||
									reviewKind() === "setup" ||
									developerReviewPhase()
										? [
												{
													key: "f",
													action:
														reviewKind() === "stage" &&
														stageWikiUpdateAvailable()
															? "Approve and update wiki"
															: "Finish review",
												},
											]
										: []),
									...(reviewKind() === "plan"
										? [{ key: "r", action: "Reject plan" }]
										: []),
									...(reviewKind() === "stage" && stageWikiUpdateAvailable()
										? [{ key: "Shift+F", action: "Approve report (skip wiki)" }]
										: []),
									...(reviewKind() === "developer" &&
									reviewVisibleChanges().length === 0
										? [{ key: "c", action: "Comment on the report" }]
										: []),
									{ key: "Esc", action: "Postpone" },
								]
					}
					{...reviewFilesBackdrop}
				>
					<ChangedFilesView
						findings
						changes={reviewChangesForView()}
						selectedIndex={reviewChangeIndex()}
						searchMode={reviewSearchMode()}
						searchQuery={reviewSearchQuery()}
						availableLines={reviewFilesAvailableLines()}
						onClose={() => {
							setReviewOpen(false);
							props.setModalActive("none");
						}}
					/>
				</GenericModal>
			</Show>
			<Show
				when={
					reviewOpen() &&
					props.modalTop() === "review" &&
					reviewView() === "diff" &&
					(reviewKind() === "plan" || reviewKind() === "stage") &&
					reviewFile()
				}
			>
				<MarkdownViewModal
					filePath={reviewFile()?.newPath ?? ""}
					content={reviewDiff()}
					currentFileIndex={reviewChangeIndex()}
					totalFiles={reviewVisibleChanges().length}
					selectedLine={reviewLine()}
					visualModeActive={reviewVisualMode()}
					visualModeStart={reviewVisualStart()}
					commentMode={reviewCommentMode()}
					commentText={reviewCommentText()}
					footerKeybinds={
						reviewKind() === "stage"
							? props.stageReportKeybinds
							: stagePlanReview()
								? props.stagePlanKeybinds
								: undefined
					}
					discussions={currentReviewDiscussions()}
					onSelectedLineChange={setReviewLine}
					onSelectedSourceRangeChange={(start, end) =>
						setReviewSourceRange({ start, end })
					}
					onDiscussionLineIndicesChange={setReviewDiscussionLineIndices}
					onSelectableLineCountChange={setReviewSelectableLineCount}
					onClose={() => {
						setReviewVisualMode(false);
						setReviewCommentMode(false);
						if (reviewKind() === "stage" || stagePlanReview()) {
							setReviewOpen(false);
							props.setModalActive("none");
						} else {
							setReviewView("files");
						}
					}}
					onNavigateFile={(direction) =>
						reviewKind() === "stage" || stagePlanReview()
							? undefined
							: void navigatePlanMarkdownFile(direction)
					}
				/>
			</Show>
			<Show
				when={
					reviewOpen() &&
					props.modalTop() === "review" &&
					reviewView() === "diff" &&
					(reviewKind() === "developer" ||
						reviewKind() === "wiki" ||
						reviewKind() === "setup") &&
					reviewDiffFile()
				}
			>
				{(file) => (
					<DiffViewModal
						filePath={file().new_path}
						diff={file().diff}
						currentFileIndex={reviewChangeIndex()}
						totalFiles={reviewVisibleChanges().length}
						selectedLine={reviewLine()}
						visualModeActive={reviewVisualMode()}
						visualModeStart={reviewVisualStart()}
						forceSplitView={reviewSplitView()}
						isNewFile={file().new_file}
						isDeletedFile={file().deleted_file}
						{...(file().affects_all_apps
							? { flagLabel: "affects all apps" }
							: {})}
						currentSideOnly={reviewKind() !== "developer"}
						renderMarkdown={reviewKind() === "wiki"}
						commentMode={reviewCommentMode()}
						commentText={reviewCommentText()}
						discussions={reviewDiscussions()}
						onSelectedLineChange={setReviewLine}
						onSelectedSourceRangeChange={(start, end) =>
							setReviewSourceRange({ start, end })
						}
						onDiscussionLineIndicesChange={setReviewDiscussionLineIndices}
						onSelectableLineCountChange={setReviewSelectableLineCount}
						onSelectedFindingIdsChange={setReviewSelectedLineFindingIds}
						onClose={() => {
							setReviewVisualMode(false);
							setReviewCommentMode(false);
							setReviewView("files");
						}}
						onNavigateFile={(direction) => void navigateReviewFile(direction)}
					/>
				)}
			</Show>
		</>
	);
}
