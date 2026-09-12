import type { DevEnvClient } from "@devenv/core";
import { getLogger } from "@devenv/core";
import type { AppStore } from "../stores/app-store";
import type { ChangeRequestStore } from "../stores/cr-store";
import type { UiStore } from "../stores/ui-store";

const AI_ATTRIBUTION_HEADER = `> 🤖 *This review was generated automatically by AI. Please verify all suggestions before acting on them.*

---

`;

const UNKNOWN_ERROR = "Unknown error";

let crListAbortController: AbortController | null = null;
let crDetailAbortController: AbortController | null = null;

const isAbortError = (e: unknown) =>
	e instanceof DOMException && e.name === "AbortError";

/** Extract error message safely. */
function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : UNKNOWN_ERROR;
}

export function createCrActions(
	appStore: AppStore,
	changeRequestStore: ChangeRequestStore,
	uiStore: UiStore,
	client: DevEnvClient,
	showError: (title: string, message: string) => void,
) {
	const getSelectedApp = () =>
		appStore.tableFilteredApps()[appStore.selectedIndex()];

	const abortCrListLoad = () => {
		crListAbortController?.abort();
		crListAbortController = null;
	};
	const abortCrDetailLoad = () => {
		crDetailAbortController?.abort();
		crDetailAbortController = null;
	};
	const abortViewLoads = () => {
		abortCrListLoad();
		abortCrDetailLoad();
	};

	const loadChangeRequestForCurrentBranch = async () => {
		if (appStore.operationInProgressForApp())
			return showError(
				"Operation In Progress",
				"Another operation is already in progress. Please wait for it to complete.",
			);
		const app = getSelectedApp();
		if (!app) return;
		abortCrListLoad();
		const controller = new AbortController();
		crListAbortController = controller;
		changeRequestStore.setCrLoading(true);
		changeRequestStore.setCrError("");
		changeRequestStore.setSelectedCRIndex(0);
		changeRequestStore.setChangeRequests([]);
		changeRequestStore.setCurrentPage(1);
		changeRequestStore.setTotalPages(0);
		changeRequestStore.setTotalCount(0);
		appStore.pushView("changeRequests");
		try {
			const result = await client.getChangeRequests(
				app.ident,
				"opened",
				"current",
				app.sourceType,
				1,
				changeRequestStore.perPage(),
				undefined,
				undefined,
				undefined,
				undefined,
				controller.signal,
			);
			if (result.items.length > 0) {
				changeRequestStore.setChangeRequests(result.items);
				changeRequestStore.setTotalPages(result.totalPages);
				changeRequestStore.setTotalCount(result.totalCount);
				changeRequestStore.setCurrentPage(result.currentPage);
				changeRequestStore.setPerPage(result.perPage);
				showCRDetail(result.items[0]);
			} else {
				const allResult = await client.getChangeRequests(
					app.ident,
					"opened",
					"all",
					app.sourceType,
					1,
					changeRequestStore.perPage(),
					undefined,
					undefined,
					undefined,
					undefined,
					controller.signal,
				);
				changeRequestStore.setChangeRequests(allResult.items);
				changeRequestStore.setTotalPages(allResult.totalPages);
				changeRequestStore.setTotalCount(allResult.totalCount);
				changeRequestStore.setCurrentPage(allResult.currentPage);
				changeRequestStore.setPerPage(allResult.perPage);
			}
		} catch (e) {
			if (isAbortError(e)) return;
			try {
				const allResult = await client.getChangeRequests(
					app.ident,
					"opened",
					"all",
					app.sourceType,
					1,
					changeRequestStore.perPage(),
					undefined,
					undefined,
					undefined,
					undefined,
					controller.signal,
				);
				changeRequestStore.setChangeRequests(allResult.items);
				changeRequestStore.setTotalPages(allResult.totalPages);
				changeRequestStore.setTotalCount(allResult.totalCount);
				changeRequestStore.setCurrentPage(allResult.currentPage);
				changeRequestStore.setPerPage(allResult.perPage);
			} catch {
				changeRequestStore.setChangeRequests([]);
			}
		} finally {
			if (crListAbortController === controller) crListAbortController = null;
			if (!controller.signal.aborted) changeRequestStore.setCrLoading(false);
		}
	};

	const loadAllChangeRequests = async (
		page?: number,
		search?: string,
		state?: string,
	) => {
		if (appStore.operationInProgressForApp())
			return showError(
				"Operation In Progress",
				"Another operation is already in progress. Please wait for it to complete.",
			);
		const app = getSelectedApp();
		if (!app) return;
		abortCrListLoad();
		const controller = new AbortController();
		crListAbortController = controller;
		const p = page ?? changeRequestStore.currentPage();
		const s =
			state ?? changeRequestStore.crListFilters().state?.[0] ?? "opened";
		changeRequestStore.setCrLoading(true);
		changeRequestStore.setCrError("");
		changeRequestStore.setSelectedCRIndex(0);
		appStore.pushView("changeRequests");
		try {
			const result = await client.getChangeRequests(
				app.ident,
				s,
				"all",
				app.sourceType,
				p,
				changeRequestStore.perPage(),
				search,
				changeRequestStore.activeCrListSort()?.key,
				changeRequestStore.activeCrListSort()?.direction as
					| "asc"
					| "desc"
					| undefined,
				undefined,
				controller.signal,
			);
			changeRequestStore.setChangeRequests(result.items);
			changeRequestStore.setTotalPages(result.totalPages);
			changeRequestStore.setTotalCount(result.totalCount);
			changeRequestStore.setCurrentPage(result.currentPage);
			changeRequestStore.setPerPage(result.perPage);
		} catch (e) {
			if (!isAbortError(e)) {
				changeRequestStore.setCrError(errMsg(e));
				changeRequestStore.setChangeRequests([]);
			}
		} finally {
			if (crListAbortController === controller) crListAbortController = null;
			if (!controller.signal.aborted) changeRequestStore.setCrLoading(false);
		}
	};

	const showCRDetail = (
		cr: NonNullable<
			ReturnType<typeof changeRequestStore.selectedChangeRequest>
		>,
	) => {
		const app = getSelectedApp();
		abortCrDetailLoad();
		const mayLoadPipeline = !!cr.head_pipeline || app?.sourceType === "github";
		changeRequestStore.setSelectedCR(cr);
		changeRequestStore.setCrChangesLoading(true);
		changeRequestStore.setCrTestLoading(mayLoadPipeline);
		changeRequestStore.setCrJobsForDetailLoading(mayLoadPipeline);
		changeRequestStore.setCrDiscussionsLoading(true);
		changeRequestStore.setCrChanges([]);
		changeRequestStore.setCrChangesError("");
		changeRequestStore.setCrTestSummary(null);
		changeRequestStore.setCrTestError("");
		changeRequestStore.setCrJobsForDetail([]);
		changeRequestStore.setCrJobsForDetailError("");
		changeRequestStore.setCrDiscussions([]);
		changeRequestStore.setCrDiscussionsError("");
		changeRequestStore.setCrDetailPanelIndex(0);
		appStore.pushView("changeRequestDetail");
		void loadCRDetailData(cr);
	};

	const loadCRDetailData = async (
		cr: NonNullable<
			ReturnType<typeof changeRequestStore.selectedChangeRequest>
		>,
	) => {
		const app = getSelectedApp();
		if (!app) return;
		const controller = new AbortController();
		crDetailAbortController = controller;

		let detailCr = cr;
		if (app.sourceType === "github" && !cr.head_pipeline) {
			try {
				detailCr = await client.getChangeRequest(
					app.ident,
					cr.iid,
					app.sourceType,
					controller.signal,
				);
				changeRequestStore.setSelectedCR(detailCr);
			} catch (e) {
				const msg = errMsg(e);
				changeRequestStore.setCrJobsForDetailError(
					`Failed to load pipeline details: ${msg}`,
				);
				changeRequestStore.setCrTestError(
					`Failed to load pipeline details: ${msg}`,
				);
			} finally {
				if (!detailCr.head_pipeline) {
					changeRequestStore.setCrJobsForDetailLoading(false);
					changeRequestStore.setCrTestLoading(false);
				}
			}
		}

		const changesPromise = (async () => {
			try {
				changeRequestStore.setCrChanges(
					await client.getChangeRequestChanges(
						app.ident,
						detailCr.iid,
						app.sourceType,
						controller.signal,
					),
				);
			} catch (e) {
				changeRequestStore.setCrChangesError(errMsg(e));
			} finally {
				changeRequestStore.setCrChangesLoading(false);
			}
		})();
		const jobsPromise = (async () => {
			if (!detailCr.head_pipeline) return;
			try {
				changeRequestStore.setCrJobsForDetail(
					await client.getPipelineJobs(
						app.ident,
						detailCr.head_pipeline.id,
						app.sourceType,
						controller.signal,
					),
				);
			} catch (e) {
				changeRequestStore.setCrJobsForDetailError(errMsg(e));
			} finally {
				changeRequestStore.setCrJobsForDetailLoading(false);
			}
		})();
		const testSummaryPromise = (async () => {
			if (!detailCr.head_pipeline) return;
			try {
				changeRequestStore.setCrTestSummary(
					await client.getTestSummary(
						app.ident,
						detailCr.head_pipeline.id,
						app.sourceType,
						controller.signal,
					),
				);
			} catch (e) {
				changeRequestStore.setCrTestError(errMsg(e));
			} finally {
				changeRequestStore.setCrTestLoading(false);
			}
		})();
		const linkedIssuesPromise = (async () => {
			try {
				changeRequestStore.setCrLinkedIssues(
					await client.getCRLinkedIssues(
						app.ident,
						detailCr.iid,
						app.sourceType,
						controller.signal,
					),
				);
			} catch (e) {
				changeRequestStore.setCrLinkedIssuesError(errMsg(e));
			} finally {
				changeRequestStore.setCrLinkedIssuesLoading(false);
			}
		})();
		const discussionsPromise = (async () => {
			try {
				changeRequestStore.setCrDiscussions(
					await client.getCRDiscussions(
						app.ident,
						detailCr.iid,
						app.sourceType,
						controller.signal,
					),
				);
			} catch (e) {
				changeRequestStore.setCrDiscussionsError(errMsg(e));
			} finally {
				changeRequestStore.setCrDiscussionsLoading(false);
			}
		})();
		await Promise.all([
			changesPromise,
			jobsPromise,
			testSummaryPromise,
			discussionsPromise,
			linkedIssuesPromise,
		]);
		if (crDetailAbortController === controller) crDetailAbortController = null;
	};

	const submitComment = async () => {
		const app = appStore.filteredApps()[appStore.selectedIndex()];
		const cr = changeRequestStore.selectedChangeRequest();
		const comment = changeRequestStore.commentText().trim();
		const diffFile = changeRequestStore.currentDiffFile();
		if (!comment)
			return showError(
				"Empty Comment",
				"Please enter a comment before submitting",
			);
		if (!app || !cr || !diffFile)
			return showError(
				"Invalid State",
				"Missing required data for creating comment",
			);
		changeRequestStore.setCommentSubmitting(true);
		try {
			const versions = await client.getCRVersions(app.ident, cr.iid);
			if (!versions.length)
				return showError("No Versions", "Could not fetch CR versions");
			const latest = versions[0];
			const position = {
				baseSHA: latest.base_commit_sha,
				headSHA: latest.head_commit_sha,
				startSHA: latest.start_commit_sha,
				positionType: "text",
				newPath: diffFile.new_path,
				oldPath: diffFile.old_path,
				newLine:
					diffFile.diff_lines?.[changeRequestStore.diffModalSelectedLine()]
						?.new_line,
				oldLine:
					diffFile.diff_lines?.[changeRequestStore.diffModalSelectedLine()]
						?.old_line,
			};
			await client.createCRComment(app.ident, cr.iid, comment, position);
			showError(
				"Comment Posted",
				"Your comment was successfully added to the change request",
			);
			changeRequestStore.setShowCommentModal(false);
			changeRequestStore.setCommentText("");
			changeRequestStore.setDiffModalVisualMode(false);
		} catch (e) {
			showError("Comment Failed", `Failed to create comment: ${errMsg(e)}`);
		} finally {
			changeRequestStore.setCommentSubmitting(false);
		}
	};

	const replyToDiscussion = async (discussionID: string, body: string) => {
		const app = appStore.filteredApps()[appStore.selectedIndex()];
		const cr = changeRequestStore.selectedChangeRequest();
		if (!app || !cr)
			return showError(
				"Invalid State",
				"Missing required data for replying to discussion",
			);
		if (!body.trim())
			return showError("Empty Reply", "Please enter a reply before submitting");
		try {
			await client.replyToDiscussion(app.ident, cr.iid, discussionID, body);
			changeRequestStore.setCrDiscussions(
				await client.getCRDiscussions(app.ident, cr.iid, app.sourceType),
			);
			showError("Reply Posted", "Your reply was successfully added");
		} catch (e) {
			showError("Reply Failed", `Failed to post reply: ${errMsg(e)}`);
		}
	};

	const resolveDiscussion = async (
		discussionID: string,
		resolveAction: "resolve" | "unresolve",
	) => {
		const app = appStore.filteredApps()[appStore.selectedIndex()];
		const cr = changeRequestStore.selectedChangeRequest();
		if (!app || !cr)
			return showError(
				"Invalid State",
				"Missing required data for resolving discussion",
			);
		try {
			await client.resolveDiscussion(
				app.ident,
				cr.iid,
				discussionID,
				resolveAction,
			);
			changeRequestStore.setCrDiscussions(
				await client.getCRDiscussions(app.ident, cr.iid, app.sourceType),
			);
		} catch (e) {
			showError("Resolve Failed", `Failed to resolve discussion: ${errMsg(e)}`);
		}
	};

	const nextPage = async () => {
		const app = getSelectedApp();
		if (!app) return;
		const current = changeRequestStore.currentPage();
		const total = changeRequestStore.totalPages();
		if (total > 0 && current >= total) return;
		await loadAllChangeRequests(current + 1, changeRequestStore.searchTerm());
	};

	const prevPage = async () => {
		const app = getSelectedApp();
		if (!app) return;
		const current = changeRequestStore.currentPage();
		if (current <= 1) return;
		await loadAllChangeRequests(current - 1, changeRequestStore.searchTerm());
	};

	const backToCRList = () => {
		changeRequestStore.setSelectedCR(null);
		changeRequestStore.setCrSearchMode(false);
		changeRequestStore.setCrSearchQuery("");
		appStore.popView();
	};

	const toggleCRApproval = async () => {
		const app = getSelectedApp();
		const cr = changeRequestStore.selectedChangeRequest();
		if (!app || !cr) return;
		try {
			uiStore.setLoadingModalMessage("Toggling approval");
			uiStore.setShowLoadingModal(true);
			await client.toggleCRApproval(app.ident, cr.iid, app.sourceType);
			const fetched = await client.getChangeRequests(
				app.ident,
				changeRequestStore.crListFilters().state?.[0] ?? "opened",
				"all",
				app.sourceType,
				changeRequestStore.currentPage(),
				changeRequestStore.perPage(),
			);
			const updated = fetched.items.find((m) => m.iid === cr.iid);
			if (updated) {
				changeRequestStore.setSelectedCR(updated);
				changeRequestStore.setChangeRequests((crs) =>
					crs.map((m) => (m.iid === updated.iid ? updated : m)),
				);
			}
			await loadCRDetailData(updated || cr);
		} catch (e) {
			showError("Approval Toggle Failed", errMsg(e));
		} finally {
			uiStore.setShowLoadingModal(false);
		}
	};

	const rebaseCR = async () => {
		const app = getSelectedApp();
		const cr = changeRequestStore.selectedChangeRequest();
		if (!app || !cr) return;
		try {
			uiStore.setLoadingModalMessage("Rebasing change request");
			uiStore.setShowLoadingModal(true);
			await client.rebaseCR(app.ident, cr.iid);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			const fetched = await client.getChangeRequests(
				app.ident,
				changeRequestStore.crListFilters().state?.[0] ?? "opened",
				"all",
				app.sourceType,
				changeRequestStore.currentPage(),
				changeRequestStore.perPage(),
			);
			const updated = fetched.items.find((m) => m.iid === cr.iid);
			if (updated) {
				changeRequestStore.setSelectedCR(updated);
				changeRequestStore.setChangeRequests((crs) =>
					crs.map((m) => (m.iid === updated.iid ? updated : m)),
				);
				if (updated.merge_error)
					showError("Rebase Failed", updated.merge_error);
				else if (updated.rebase_in_progress)
					showError(
						"Rebase In Progress",
						"Rebase operation has been queued and is currently in progress. Please wait for it to complete.",
					);
				else
					showError(
						"Rebase Successful",
						"Change request has been rebased successfully.",
					);
			}
			await loadCRDetailData(updated || cr);
		} catch (e) {
			showError("Rebase Failed", errMsg(e));
			getLogger().write(
				"ERROR",
				`Failed to rebase CR: ${e instanceof Error ? e.message : String(e)}`,
			);
		} finally {
			uiStore.setShowLoadingModal(false);
		}
	};

	const getDiscussionAtCurrentLine = () => {
		const diffFile = changeRequestStore.currentDiffFile();
		const lineIndex = changeRequestStore.diffModalSelectedLine();
		if (!diffFile?.diff_lines || !changeRequestStore.crDiscussions())
			return null;
		const diffLine = diffFile.diff_lines[lineIndex];
		if (!diffLine) return null;
		for (const discussion of changeRequestStore.crDiscussions()) {
			const position = discussion.position || discussion.notes[0]?.position;
			if (!position) continue;
			const matchesFile =
				position.new_path === diffFile.new_path ||
				position.old_path === diffFile.old_path;
			if (!matchesFile) continue;
			if (diffLine.type === "new" && position.new_line === diffLine.new_line)
				return discussion;
			if (diffLine.type === "old" && position.old_line === diffLine.old_line)
				return discussion;
			if (
				diffLine.type === "match" &&
				(position.new_line === diffLine.new_line ||
					position.old_line === diffLine.old_line)
			)
				return discussion;
		}
		return null;
	};

	const getLinesWithComments = (): number[] => {
		const diffFile = changeRequestStore.currentDiffFile();
		if (!diffFile || !changeRequestStore.crDiscussions()) return [];
		const discussions = changeRequestStore.crDiscussions();
		const linesWithComments: number[] = [];
		const diffLines = diffFile.diff.split("\n");
		let selectableIndex = 0;
		let oldLineNum = 0;
		let newLineNum = 0;

		/** Check if a discussion has a comment at the given diff position. */
		const hasLineCommentFn = (
			discussion: (typeof discussions)[number],
			lt: "added" | "removed" | "context" | null,
			curOld: number | undefined,
			curNew: number | undefined,
		) => {
			const position = discussion.position || discussion.notes[0]?.position;
			if (!position) return false;
			const matchesFile =
				position.new_path === diffFile.new_path ||
				position.old_path === diffFile.old_path;
			if (!matchesFile) return false;
			const matchesNewLine =
				lt === "added" && curNew && position.new_line === curNew;
			const matchesOldLine =
				lt === "removed" && curOld && position.old_line === curOld;
			const matchesContext =
				lt === "context" &&
				(position.new_line === curNew || position.old_line === curOld);
			return matchesNewLine || matchesOldLine || matchesContext;
		};

		for (const line of diffLines) {
			if (line.startsWith("---") || line.startsWith("+++")) continue;
			if (line.startsWith("@@")) {
				const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
				if (match) {
					oldLineNum = parseInt(match[1], 10) - 1;
					newLineNum = parseInt(match[2], 10) - 1;
				}
				continue;
			}
			let lineType: "added" | "removed" | "context" | null = null;
			let currentOldLine: number | undefined;
			let currentNewLine: number | undefined;
			if (line.startsWith("+")) {
				newLineNum++;
				lineType = "added";
				currentNewLine = newLineNum;
			} else if (line.startsWith("-")) {
				oldLineNum++;
				lineType = "removed";
				currentOldLine = oldLineNum;
			} else if (line.startsWith(" ")) {
				oldLineNum++;
				newLineNum++;
				lineType = "context";
				currentOldLine = oldLineNum;
				currentNewLine = newLineNum;
			} else if (line.trim()) {
				selectableIndex++;
				continue;
			} else {
				continue;
			}
			const hasComment = discussions.some((d) =>
				hasLineCommentFn(d, lineType, currentOldLine, currentNewLine),
			);
			if (hasComment) linesWithComments.push(selectableIndex);
			selectableIndex++;
		}
		return linesWithComments;
	};

	const runCrAiReview = async (prompt?: string) => {
		const cr = changeRequestStore.selectedChangeRequest();
		const app = getSelectedApp();
		if (!cr || !app) return;

		const { buildCrReviewPrompt } = await import("./cr-ai-utils");
		const reviewPrompt = prompt ?? buildCrReviewPrompt(cr);

		changeRequestStore.setCrAiVisible(true);
		changeRequestStore.setCrAiLoading(true);
		changeRequestStore.setCrAiStreaming(false);
		changeRequestStore.setCrAiSummary(null);
		changeRequestStore.setCrAiError(null);
		changeRequestStore.crAiAtBottom = true;
		changeRequestStore.crAiLastScrollTop = 0;

		try {
			let firstDelta = true;
			for await (const delta of client.analyzeCRWithAIStream(
				app.ident,
				cr.iid,
				cr.source_branch,
				cr.target_branch,
				reviewPrompt,
			)) {
				if (firstDelta) {
					changeRequestStore.setCrAiLoading(false);
					changeRequestStore.setCrAiStreaming(true);
					changeRequestStore.setCrAiSummary("");
					firstDelta = false;
				}
				changeRequestStore.setCrAiSummary((prev) => (prev ?? "") + delta);
				if (
					changeRequestStore.crAiAtBottom &&
					changeRequestStore.crAiScrollBoxRef
				) {
					if (
						changeRequestStore.crAiScrollBoxRef.scrollTop !==
						changeRequestStore.crAiLastScrollTop
					) {
						changeRequestStore.crAiAtBottom = false;
					} else {
						changeRequestStore.crAiScrollBoxRef.scrollTo(
							changeRequestStore.crAiScrollBoxRef.scrollHeight,
						);
						changeRequestStore.crAiLastScrollTop =
							changeRequestStore.crAiScrollBoxRef.scrollTop;
					}
				}
			}
			if (firstDelta) {
				// No output at all — set empty summary so overlay shows done state
				changeRequestStore.setCrAiLoading(false);
				changeRequestStore.setCrAiSummary("");
			}
		} catch (e) {
			changeRequestStore.setCrAiError(
				e instanceof Error ? e.message : "AI review failed",
			);
		} finally {
			changeRequestStore.setCrAiLoading(false);
			changeRequestStore.setCrAiStreaming(false);
		}
	};

	const postCrAiComments = async () => {
		const summary = changeRequestStore.crAiSummary();
		const app = getSelectedApp();
		const cr = changeRequestStore.selectedChangeRequest();
		if (!summary || !app || !cr) return;
		if (app.sourceType === "github") {
			showError(
				"Not Supported",
				"Posting AI review comments is only supported for GitLab CRs.",
			);
			return;
		}
		changeRequestStore.setCrAiPostingComments(true);
		try {
			const body = AI_ATTRIBUTION_HEADER + summary;
			await client.createCRComment(app.ident, cr.iid, body);
			changeRequestStore.setCrAiCommentsPosted(true);
		} catch (e) {
			changeRequestStore.setCrAiError(`Failed to post comments: ${errMsg(e)}`);
		} finally {
			changeRequestStore.setCrAiPostingComments(false);
		}
	};

	return {
		loadChangeRequestForCurrentBranch,
		loadAllChangeRequests,
		nextPage,
		prevPage,
		showCRDetail,
		loadCRDetailData,
		abortViewLoads,
		submitComment,
		replyToDiscussion,
		resolveDiscussion,
		backToCRList,
		toggleCRApproval,
		rebaseCR,
		getDiscussionAtCurrentLine,
		getLinesWithComments,
		runCrAiReview,
		postCrAiComments,
	};
}

export type CrActions = ReturnType<typeof createCrActions>;
