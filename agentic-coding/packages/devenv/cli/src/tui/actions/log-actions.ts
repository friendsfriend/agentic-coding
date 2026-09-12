import type { DevEnvClient } from "@devenv/core";
import type { AppStore } from "../stores/app-store";
import type { LogStore } from "../stores/log-store";

let logStreamAbortController: AbortController | null = null;

export function createLogActions(
	logStore: LogStore,
	appStore: AppStore,
	client: DevEnvClient,
	showError: (title: string, message: string) => void,
) {
	const syncLogScroll = () => {
		if (!logStore.logScrollBoxRef) return;
		logStore.setLogScrollTop(logStore.logScrollBoxRef.scrollTop);
		const h = logStore.logScrollBoxRef.viewport.height;
		if (h > 0) logStore.setLogViewportHeight(h);
	};

	const resetLogHistory = () => {
		logStore.setLogHistoryCursor(null);
		logStore.setLogHistoryHasMore(false);
		logStore.setLogHistoryLoading(false);
		logStore.setLogHistoryError(null);
	};

	/**
	 * Set logScrollTop to the bottom of the current log content so the viewport
	 * starts at the last lines. No sb.scrollTo() here — stickyScroll handles the
	 * initial viewport placement. syncLogScroll() (called from onScrollBoxReady)
	 * reads the actual scrollTop after the scrollbox settles.
	 */
	const scrollToLogBottom = () => {
		const lineCount = logStore.logs().split("\n").length;
		const sb = logStore.logScrollBoxRef;
		const vh =
			sb && sb.viewport.height > 0
				? sb.viewport.height
				: logStore.logViewportHeight();
		if (vh > 0) logStore.setLogViewportHeight(vh);
		logStore.setLogScrollTop(Math.max(0, lineCount - vh));
	};

	const clearAiState = () => {
		logStore.setLogAiPromptMode(false);
		logStore.setLogAiPromptText("");
		logStore.setLogAiLoading(false);
		logStore.setLogAiStreaming(false);
		logStore.setLogAiSummary(null);
		logStore.setLogAiError(null);
		logStore.setLogAiFollowupText("");
		logStore.setLogAiHistory([]);
		logStore.setLogAiVisible(false);
		logStore.logAiScrollBoxRef = undefined;
		logStore.logAiAtBottom = true;
		logStore.logAiLastScrollTop = 0;
	};

	const dismissAiOverlay = () => {
		logStore.setLogAiVisible(false);
	};

	const closeLogModal = () => {
		if (logStreamAbortController) {
			logStreamAbortController.abort();
			logStreamAbortController = null;
		}
		logStore.setShowLogModal(false);
		logStore.setLogs("");
		logStore.setLogTitle("");
		logStore.setLogType(null);
		logStore.logScrollBoxRef = undefined;
		logStore.setLogScrollTop(0);
		logStore.setLogViewportHeight(40);
		logStore.setLogSearchMode(false);
		logStore.setLogSearchQuery("");
		logStore.setLogSearchMatchIndex(-1);
		resetLogHistory();
		clearAiState();
		logStore.setLogRefreshParams({ type: null });
	};

	const getSelectedApp = () =>
		appStore.filteredApps()[appStore.selectedIndex()];

	const loadContainerLogs = async () => {
		const app = getSelectedApp();
		if (!app) return;
		if ("type" in app && app.type === "script") {
			if (!app.logPath) {
				showError(
					"No Script Log",
					`${app.displayName} is running in tmux window mode. Open the tmux window to view logs.`,
				);
				return;
			}
			logStore.setLogs("");
			logStore.setLogTitle(`Script Logs: ${app.displayName}`);
			logStore.setLogType("container");
			logStore.setShowLogModal(true);
			logStore.setLogRefreshParams({ type: null });
			try {
				logStore.setLogs(await client.getInfraServiceLogs(app.ident));
				scrollToLogBottom();
			} catch (e) {
				logStore.setLogs(
					`Error fetching script logs: ${e instanceof Error ? e.message : "Unknown error"}`,
				);
			}
			return;
		}
		const legacyKubernetesStatus =
			typeof app.status === "string" &&
			/\b(?:running|starting)\b.*\bpods?\b/i.test(app.status);
		if (
			("type" in app && app.type === "kubernetes") ||
			((app.runtimeStatus?.detail?.includes("pods") ||
				legacyKubernetesStatus) &&
				!app.dockerInfo?.ContainerID)
		) {
			logStore.setLogs("");
			logStore.setLogTitle(`Kubernetes Logs: ${app.displayName} (live)`);
			logStore.setLogType("container");
			logStore.setShowLogModal(true);
			logStore.setLogRefreshParams({ type: null });
			try {
				logStore.setLogs(await client.getKubernetesLogs(app.ident));
				scrollToLogBottom();
				logStore.setLogRefreshParams({
					type: "kubernetes",
					appIdent: app.ident,
				});
			} catch (e) {
				logStore.setLogs(
					`Error fetching Kubernetes logs: ${e instanceof Error ? e.message : "Unknown error"}`,
				);
			}
			return;
		}
		if (!app.dockerInfo?.ContainerID) {
			logStore.setLogs(`No running container found for ${app.displayName}`);
			logStore.setLogTitle(`Container Logs: ${app.displayName}`);
			logStore.setLogType("container");
			logStore.setShowLogModal(true);
			logStore.setLogRefreshParams({ type: null });
			return;
		}
		const containerID = app.dockerInfo.ContainerID;
		logStore.setLogs("");
		logStore.setLogTitle(`Container Logs: ${app.displayName} (live)`);
		logStore.setLogType("container");
		logStore.setShowLogModal(true);
		logStore.setLogRefreshParams({ type: null });
		try {
			logStore.setLogs(await client.getContainerLogs(containerID));
			scrollToLogBottom();
			logStore.setLogRefreshParams({ type: "container", containerID });
		} catch (e) {
			logStore.setLogs(
				`Error fetching container logs: ${e instanceof Error ? e.message : "Unknown error"}`,
			);
		}
	};

	const loadJobLogs = async (jobId: number, jobName: string) => {
		const app = appStore.tableFilteredApps()[appStore.selectedIndex()];
		if (!app) return;
		const isGitLab = app.sourceType !== "github";
		const refreshLabel = isGitLab ? "live" : "auto-refresh: 10s";
		logStore.setLogs("");
		logStore.setLogTitle(`Job Logs: ${jobName} (#${jobId})`);
		logStore.setLogType("job");
		logStore.setShowLogModal(true);
		logStore.setLogRefreshParams({ type: null });
		try {
			logStore.setLogs(
				await client.getJobLogs(app.ident, jobId, app.sourceType),
			);
			scrollToLogBottom();
			logStore.setLogTitle(
				`Job Logs: ${jobName} (#${jobId}) (${refreshLabel})`,
			);
			logStore.setLogRefreshParams({
				type: "job",
				appIdent: app.ident,
				jobId,
				sourceType: app.sourceType,
			});
		} catch (e) {
			logStore.setLogs(
				`Error fetching job logs: ${e instanceof Error ? e.message : "Unknown error"}`,
			);
		}
	};

	const runAiAnalysis = async (
		followupQuestion?: string,
		logsOverride?: string,
	) => {
		logStore.setLogAiLoading(true);
		logStore.setLogAiStreaming(false);
		logStore.setLogAiError(null);
		logStore.setLogAiVisible(true);
		logStore.logAiAtBottom = true;
		logStore.logAiLastScrollTop = 0;
		const isFollowup = !!followupQuestion;
		if (!isFollowup) {
			logStore.setLogAiSummary(null);
		}
		const buildPrompt = (): string | undefined => {
			if (!isFollowup) return logStore.logAiPromptText() || undefined;
			const history = logStore.logAiHistory();
			const parts: string[] = [];
			for (const entry of history)
				parts.push(
					entry.role === "user"
						? `User: ${entry.content}`
						: `Assistant: ${entry.content}`,
				);
			parts.push(`User: ${followupQuestion}`);
			return parts.join("\n\n");
		};
		const prompt = buildPrompt();
		let fullResponse = "";
		try {
			let firstDelta = true;
			for await (const delta of client.analyzeLogsWithAIStream(
				logsOverride ?? logStore.logs(),
				prompt,
			)) {
				if (firstDelta) {
					logStore.setLogAiLoading(false);
					logStore.setLogAiStreaming(true);
					if (isFollowup)
						logStore.setLogAiSummary(
							(prev) => `${prev ?? ""}\n\n---\n\n**${followupQuestion}**\n\n`,
						);
					else logStore.setLogAiSummary("");
					firstDelta = false;
				}
				fullResponse += delta;
				logStore.setLogAiSummary((prev) => (prev ?? "") + delta);
				if (logStore.logAiAtBottom && logStore.logAiScrollBoxRef) {
					if (
						logStore.logAiScrollBoxRef.scrollTop !== logStore.logAiLastScrollTop
					) {
						logStore.logAiAtBottom = false;
					} else {
						logStore.logAiScrollBoxRef.scrollTo(
							logStore.logAiScrollBoxRef.scrollHeight,
						);
						logStore.logAiLastScrollTop = logStore.logAiScrollBoxRef.scrollTop;
					}
				}
			}
			if (firstDelta) {
				logStore.setLogAiLoading(false);
				if (!isFollowup) logStore.setLogAiSummary("");
			}
			if (isFollowup && followupQuestion && fullResponse) {
				logStore.setLogAiHistory((h) => [
					...h,
					{ role: "user", content: followupQuestion },
					{ role: "assistant", content: fullResponse },
				]);
			} else if (!isFollowup && fullResponse) {
				const userPrompt =
					logStore.logAiPromptText() || "summarize errors and warnings";
				logStore.setLogAiHistory([
					{ role: "user", content: userPrompt },
					{ role: "assistant", content: fullResponse },
				]);
			}
		} catch (e) {
			logStore.setLogAiError(
				e instanceof Error ? e.message : "AI analysis failed",
			);
		} finally {
			logStore.setLogAiLoading(false);
			logStore.setLogAiStreaming(false);
		}
	};

	const setLogStreamAbortController = (controller: AbortController | null) => {
		logStreamAbortController = controller;
	};

	return {
		loadContainerLogs,
		loadJobLogs,
		runAiAnalysis,
		dismissAiOverlay,
		clearAiState,
		closeLogModal,
		syncLogScroll,
		scrollToLogBottom,
		setLogStreamAbortController,
		getLogStreamAbortController: () => logStreamAbortController,
	};
}

export type LogActions = ReturnType<typeof createLogActions>;
