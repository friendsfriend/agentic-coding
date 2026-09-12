import { isDownKey, isUpKey } from "./nav-keys";
import { isReverseTabKey } from "./panel-keys";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types";
/**
 * Handles keyboard events for the Jobs view:
 * - Search mode (type query, clear)
 * - / to search, ESC to go back
 * - v to view job logs, r to retry, c to cancel
 * - Tab for stage selection
 * - j/k for navigation
 */
export async function handleJobsKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
	_ctx: KeyboardContext,
): Promise<boolean> {
	const { appStore, changeRequestStore } = stores;
	const { logActions, pipelineActions } = actions;

	if (appStore.viewMode() !== "jobs") return false;

	// Jobs search mode — capture all keys while user is typing
	if (changeRequestStore.jobsSearchMode()) {
		if (
			event.name === "escape" ||
			event.name === "Escape" ||
			event.name === "esc" ||
			event.sequence === "\x1b"
		) {
			changeRequestStore.setJobsSearchMode(false);
			changeRequestStore.setJobsSearchQuery("");
			changeRequestStore.setSelectedJobIndex(0);
			return true;
		}
		if (event.name === "return" || event.name === "enter") {
			changeRequestStore.setJobsSearchMode(false);
			changeRequestStore.setSelectedJobIndex(0);
			return true;
		}
		if (event.name === "backspace" || event.name === "delete") {
			changeRequestStore.setJobsSearchQuery((q) => q.slice(0, -1));
			changeRequestStore.setSelectedJobIndex(0);
			return true;
		}
		const ch = event.sequence ?? event.name ?? "";
		if (ch.length === 1 && ch >= " ") {
			changeRequestStore.setJobsSearchQuery((q) => q + ch);
			changeRequestStore.setSelectedJobIndex(0);
			return true;
		}
		return true; // swallow all other keys
	}

	// '/' to enter search mode
	if (event.name === "/" || event.sequence === "/") {
		changeRequestStore.setJobsSearchMode(true);
		changeRequestStore.setJobsSearchQuery("");
		changeRequestStore.setSelectedJobIndex(0);
		return true;
	}

	// ESC: clear search first, then go back
	if (
		event.name === "escape" ||
		event.name === "Escape" ||
		event.name === "esc"
	) {
		if (changeRequestStore.jobsSearchQuery()) {
			changeRequestStore.setJobsSearchQuery("");
			changeRequestStore.setJobsSearchMode(false);
			changeRequestStore.setSelectedJobIndex(0);
			return true;
		}
		pipelineActions.backToCRDetail();
		return true;
	}

	const organizedJobs = pipelineActions.organizeJobsByStage();
	if (organizedJobs.length === 0) return true;

	const currentStageJobs =
		organizedJobs[changeRequestStore.selectedJobStageIndex()]?.jobs || [];

	// 'v' to view job logs
	if (event.name === "v") {
		if (
			currentStageJobs.length > 0 &&
			changeRequestStore.selectedJobIndex() < currentStageJobs.length
		) {
			const job = currentStageJobs[changeRequestStore.selectedJobIndex()];
			logActions.loadJobLogs(job.id, job.name);
		}
		return true;
	}

	// 'r' to retry failed job
	if (event.name === "r") {
		if (
			currentStageJobs.length > 0 &&
			changeRequestStore.selectedJobIndex() < currentStageJobs.length
		) {
			const job = currentStageJobs[changeRequestStore.selectedJobIndex()];
			if (job.status === "failed" || job.status === "canceled") {
				pipelineActions.retryJob(job.id, job.name);
			}
		}
		return true;
	}

	// 'c' to cancel running job
	if (event.name === "c") {
		if (
			currentStageJobs.length > 0 &&
			changeRequestStore.selectedJobIndex() < currentStageJobs.length
		) {
			const job = currentStageJobs[changeRequestStore.selectedJobIndex()];
			if (job.status === "running" || job.status === "pending") {
				pipelineActions.cancelJob(job.id, job.name);
			}
		}
		return true;
	}

	// Tab/Shift+Tab to cycle through stages
	if (event.name === "tab" || event.sequence === "\t") {
		if (isReverseTabKey(event)) {
			changeRequestStore.setSelectedJobStageIndex((prev) => {
				return prev <= 0 ? organizedJobs.length - 1 : prev - 1;
			});
		} else {
			changeRequestStore.setSelectedJobStageIndex((prev) => {
				return prev >= organizedJobs.length - 1 ? 0 : prev + 1;
			});
		}
		changeRequestStore.setSelectedJobIndex(0);
		return true;
	}

	// j or Down to move down in job list
	if (isDownKey(event)) {
		changeRequestStore.setSelectedJobIndex((prev) =>
			Math.min(prev + 1, currentStageJobs.length - 1),
		);
		return true;
	}

	// k or Up to move up in job list
	if (isUpKey(event)) {
		changeRequestStore.setSelectedJobIndex((prev) => Math.max(prev - 1, 0));
		return true;
	}

	return true;
}
