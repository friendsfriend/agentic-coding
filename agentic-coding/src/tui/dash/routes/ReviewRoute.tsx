/** Review route (establish-opencode-boundaries, task 6.1).
 *
 * The three review presentations — changed-file list, diff, plan/wiki markdown —
 * as one route module. Props-in: the review feature owns its state and actions,
 * the route only decides what is visible and hands key ownership back to the
 * shell. */
import {
	ChangedFilesView,
	DiffReviewView as DiffViewModal,
	GenericModal,
	MarkdownReviewView as MarkdownViewModal,
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
}

export function ReviewRoute(props: ReviewRouteProps) {
	const {
		developerReviewPhase,
		reviewOpen,
		reviewKind,
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
								: (props.fallbackTitle ?? "Developer review")
					}
					widthPercent={0.9}
					heightPercent={0.75}
					helpText={[
						{ key: "j/k", action: "Navigate" },
						{
							key: "Enter",
							action:
								reviewKind() === "plan"
									? "Open artifact"
									: reviewKind() === "wiki"
										? "Open document"
										: "Open diff",
						},
						{ key: "/", action: "Search files" },
						...(reviewKind() === "plan" ||
						reviewKind() === "wiki" ||
						developerReviewPhase()
							? [{ key: "f", action: "Finish review" }]
							: []),
						...(reviewKind() === "plan"
							? [{ key: "r", action: "Reject plan" }]
							: []),
						{ key: "Esc", action: "Postpone" },
					]}
					onBackdropClick={() => {
						setReviewOpen(false);
						props.setModalActive("none");
					}}
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
					reviewKind() === "plan" &&
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
						setReviewView("files");
					}}
					onNavigateFile={(direction) =>
						void navigatePlanMarkdownFile(direction)
					}
				/>
			</Show>
			<Show
				when={
					reviewOpen() &&
					props.modalTop() === "review" &&
					reviewView() === "diff" &&
					(reviewKind() === "developer" || reviewKind() === "wiki") &&
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
						currentSideOnly={reviewKind() === "wiki"}
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
