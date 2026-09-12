import { stripAnsi } from "@devenv/ui";
import { createMemo, createSignal } from "solid-js";

export function createLogStore() {
	const [logLines, setLogLines] = createSignal<string[]>([]);
	const logs = createMemo(() => logLines().join("\n"));
	const setLogs = (value: string | ((prev: string) => string)) => {
		const next = typeof value === "function" ? value(logs()) : value;
		setLogLines(next ? next.split("\n") : []);
	};
	const appendLogLine = (line: string, maxLines = 5000) => {
		setLogLines((prev) => {
			const next = [...prev, line];
			return next.length > maxLines ? next.slice(next.length - maxLines) : next;
		});
	};
	const prependLogLines = (lines: string[], maxLines = 20000) => {
		if (lines.length === 0) return;
		setLogLines((prev) => {
			const next = [...lines, ...prev];
			return next.length > maxLines ? next.slice(0, maxLines) : next;
		});
	};
	const [logTitle, setLogTitle] = createSignal<string>("");
	const [logHistoryCursor, setLogHistoryCursor] = createSignal<number | null>(
		null,
	);
	const [logHistoryHasMore, setLogHistoryHasMore] = createSignal(false);
	const [logHistoryLoading, setLogHistoryLoading] = createSignal(false);
	const [logHistoryError, setLogHistoryError] = createSignal<string | null>(
		null,
	);
	const [showLogModal, setShowLogModal] = createSignal(false);
	const [logScrollTop, setLogScrollTop] = createSignal(0);
	const [logViewportHeight, setLogViewportHeight] = createSignal(40);
	const [logSearchMode, setLogSearchMode] = createSignal(false);
	const [logSearchQuery, setLogSearchQuery] = createSignal("");
	const [logSearchMatchIndex, setLogSearchMatchIndex] = createSignal(-1);
	const [logAiPromptMode, setLogAiPromptMode] = createSignal(false);
	const [logAiPromptText, setLogAiPromptText] = createSignal("");
	const [logAiLoading, setLogAiLoading] = createSignal(false);
	const [logAiStreaming, setLogAiStreaming] = createSignal(false);
	const [logAiSummary, setLogAiSummary] = createSignal<string | null>(null);
	const [logAiError, setLogAiError] = createSignal<string | null>(null);
	const [logAiFollowupText, setLogAiFollowupText] = createSignal("");
	const [logAiHistory, setLogAiHistory] = createSignal<
		Array<{ role: "user" | "assistant"; content: string }>
	>([]);
	const [logAiVisible, setLogAiVisible] = createSignal(false);
	const [logType, setLogType] = createSignal<"container" | "job" | null>(null);
	const [logRefreshParams, setLogRefreshParams] = createSignal<{
		type: "container" | "kubernetes" | "job" | null;
		containerID?: string;
		appIdent?: string;
		jobId?: number;
		sourceType?: string;
	}>({ type: null });

	const logSearchMatchLinesList = createMemo<number[]>(() => {
		const q = logSearchQuery().toLowerCase();
		if (!q) return [];
		return logs()
			.split("\n")
			.reduce<number[]>((acc, line, i) => {
				if (stripAnsi(line).toLowerCase().includes(q)) acc.push(i);
				return acc;
			}, []);
	});

	const logSearchMatchLines = createMemo(
		() => new Set(logSearchMatchLinesList()),
	);

	let logScrollBoxRef: import("@opentui/core").ScrollBoxRenderable | undefined;
	let logAiScrollBoxRef:
		| import("@opentui/core").ScrollBoxRenderable
		| undefined;
	let logAiAtBottom = true;
	let logAiLastScrollTop = 0;

	return {
		logs,
		setLogs,
		logLines,
		setLogLines,
		appendLogLine,
		prependLogLines,
		logTitle,
		setLogTitle,
		logHistoryCursor,
		setLogHistoryCursor,
		logHistoryHasMore,
		setLogHistoryHasMore,
		logHistoryLoading,
		setLogHistoryLoading,
		logHistoryError,
		setLogHistoryError,
		showLogModal,
		setShowLogModal,
		logScrollTop,
		setLogScrollTop,
		logViewportHeight,
		setLogViewportHeight,
		// logSelectedLine, logVisualModeActive, logVisualModeStart removed —
		// no cursor line / visual mode; viewport scrolls directly.
		logSearchMode,
		setLogSearchMode,
		logSearchQuery,
		setLogSearchQuery,
		logSearchMatchIndex,
		setLogSearchMatchIndex,
		logAiPromptMode,
		setLogAiPromptMode,
		logAiPromptText,
		setLogAiPromptText,
		logAiLoading,
		setLogAiLoading,
		logAiStreaming,
		setLogAiStreaming,
		logAiSummary,
		setLogAiSummary,
		logAiError,
		setLogAiError,
		logAiFollowupText,
		setLogAiFollowupText,
		logAiHistory,
		setLogAiHistory,
		logAiVisible,
		setLogAiVisible,
		logType,
		setLogType,
		logRefreshParams,
		setLogRefreshParams,
		logSearchMatchLinesList,
		logSearchMatchLines,
		get logScrollBoxRef() {
			return logScrollBoxRef;
		},
		set logScrollBoxRef(value:
			| import("@opentui/core").ScrollBoxRenderable
			| undefined) {
			logScrollBoxRef = value;
		},
		get logAiScrollBoxRef() {
			return logAiScrollBoxRef;
		},
		set logAiScrollBoxRef(value:
			| import("@opentui/core").ScrollBoxRenderable
			| undefined) {
			logAiScrollBoxRef = value;
		},
		get logAiAtBottom() {
			return logAiAtBottom;
		},
		set logAiAtBottom(value: boolean) {
			logAiAtBottom = value;
		},
		get logAiLastScrollTop() {
			return logAiLastScrollTop;
		},
		set logAiLastScrollTop(value: number) {
			logAiLastScrollTop = value;
		},
	};
}

export type LogStore = ReturnType<typeof createLogStore>;
