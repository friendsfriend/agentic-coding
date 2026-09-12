import { handleHorizontalScrollKey } from "./horizontal-scroll";

import { isDownKey, isUpKey } from "./nav-keys";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types";
/**
 * Handles keyboard events for the Log modal:
 * - AI prompt mode (type prompt, submit, dismiss)
 * - Search mode (type query, navigate matches)
 * - Viewport scrolling (j/k/d/u/g/G/←/→) — no cursor line, visual mode removed
 * - Horizontal scroll (h/l)
 * - AI overlay scroll & followup input
 */
export async function handleLogModalKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
	_ctx: KeyboardContext,
): Promise<boolean> {
	const { logStore } = stores;
	const { logActions, utilActions } = actions;

	if (!logStore.showLogModal()) return false;

	// ── AI prompt mode: capture typed characters into the AI prompt ───────
	if (logStore.logAiPromptMode()) {
		if (
			event.name === "escape" ||
			event.name === "Escape" ||
			event.name === "esc" ||
			event.sequence === "\x1b" ||
			event.raw === "\x1b"
		) {
			logStore.setLogAiPromptMode(false);
			logStore.setLogAiPromptText("");
			return true;
		}
		if (event.name === "return" || event.name === "enter") {
			logStore.setLogAiPromptMode(false);
			void logActions.runAiAnalysis();
			return true;
		}
		if (event.name === "backspace" || event.name === "delete") {
			logStore.setLogAiPromptText((q) => q.slice(0, -1));
			return true;
		}
		const ch = event.sequence ?? event.name ?? "";
		if (ch.length === 1 && ch >= " ") {
			logStore.setLogAiPromptText((q) => q + ch);
			return true;
		}
		return true;
	}

	// ── Search mode: capture typed characters into the query ──────────────
	const logContentOffset = () => {
		let offset = 0;
		if (logStore.logHistoryError()) offset += 1;
		if (logStore.logHistoryLoading()) offset += 1;
		if (
			!logStore.logHistoryLoading() &&
			!logStore.logHistoryHasMore() &&
			logStore.logLines().length > 0
		)
			offset += 1;
		return offset;
	};

	const scrollToLogLine = (line: number) => {
		logStore.logScrollBoxRef?.scrollTo(line + logContentOffset());
	};

	if (logStore.logSearchMode()) {
		if (
			event.name === "escape" ||
			event.name === "Escape" ||
			event.name === "esc" ||
			event.sequence === "\x1b" ||
			event.raw === "\x1b"
		) {
			logStore.setLogSearchMode(false);
			logStore.setLogSearchQuery("");
			logStore.setLogSearchMatchIndex(-1);
			return true;
		}
		if (event.name === "return" || event.name === "enter") {
			logStore.setLogSearchMode(false);
			const matches = logStore.logSearchMatchLinesList();
			if (matches.length > 0 && logStore.logSearchMatchIndex() < 0) {
				logStore.setLogSearchMatchIndex(0);
				scrollToLogLine(matches[0]);
				logActions.syncLogScroll();
			}
			return true;
		}
		if (event.name === "backspace" || event.name === "delete") {
			logStore.setLogSearchQuery((q) => q.slice(0, -1));
			logStore.setLogSearchMatchIndex(-1);
			return true;
		}
		const ch = event.sequence ?? event.name ?? "";
		if (ch.length === 1 && ch >= " ") {
			logStore.setLogSearchQuery((q) => q + ch);
			logStore.setLogSearchMatchIndex(-1);
			return true;
		}
		return true; // swallow all other keys while typing
	}

	const writeLogsToTempFile = async (): Promise<string | null> => {
		const logContent = logStore.logs();
		if (!logContent) return null;
		const tmpPath = `/tmp/devenv-logs-${Date.now()}.log`;
		await Bun.write(tmpPath, logContent);
		return tmpPath;
	};

	// Shift+E — choose editor for current log content
	if (
		event.name === "E" ||
		event.sequence === "E" ||
		(event.name === "e" && event.shift)
	) {
		const tmpPath = await writeLogsToTempFile();
		if (tmpPath) utilActions.openEditorPicker(tmpPath);
		return true;
	}

	// e — write current log content to temp file and open in default editor
	if ((event.name === "e" && !event.shift) || event.sequence === "e") {
		const tmpPath = await writeLogsToTempFile();
		if (tmpPath) utilActions.openInEditor(tmpPath);
		return true;
	}

	// Shift+A — toggle AI overlay
	if (
		(event.name === "A" || (event.name === "a" && event.shift)) &&
		!logStore.logSearchMode()
	) {
		if (
			logStore.logAiSummary() !== null ||
			logStore.logAiLoading() ||
			logStore.logAiStreaming() ||
			logStore.logAiError() !== null ||
			logStore.logAiPromptMode()
		) {
			logStore.setLogAiVisible((v) => !v);
		} else {
			logStore.setLogAiPromptText("");
			logStore.setLogAiPromptMode(true);
			logStore.setLogAiVisible(true);
		}
		return true;
	}

	// ESC — clear followup text → hide overlay (keep state) → close modal
	if (
		event.name === "escape" ||
		event.name === "Escape" ||
		event.name === "esc" ||
		event.sequence === "\x1b" ||
		event.raw === "\x1b"
	) {
		if (logStore.logAiVisible() && logStore.logAiFollowupText()) {
			logStore.setLogAiFollowupText("");
		} else if (logStore.logSearchQuery()) {
			logStore.setLogSearchQuery("");
			logStore.setLogSearchMatchIndex(-1);
		} else if (
			logStore.logAiVisible() &&
			(logStore.logAiSummary() !== null ||
				logStore.logAiLoading() ||
				logStore.logAiError() !== null ||
				logStore.logAiPromptMode())
		) {
			logActions.dismissAiOverlay();
		} else {
			logActions.closeLogModal();
		}
		return true;
	}

	// AI overlay scroll keys (Ctrl+j/k/d/u/g/G)
	if (
		logStore.logAiVisible() &&
		logStore.logAiSummary() !== null &&
		logStore.logAiScrollBoxRef
	) {
		const aiSb = logStore.logAiScrollBoxRef;
		const name = event.name ?? "";
		if (handleHorizontalScrollKey(event, aiSb)) return true;
		if (event.ctrl && name === "j") {
			logStore.logAiAtBottom = false;
			aiSb.scrollBy(1);
			logStore.logAiLastScrollTop = aiSb.scrollTop;
			return true;
		}
		if (event.ctrl && name === "k") {
			logStore.logAiAtBottom = false;
			aiSb.scrollBy(-1);
			logStore.logAiLastScrollTop = aiSb.scrollTop;
			return true;
		}
		if (event.ctrl && name === "d") {
			logStore.logAiAtBottom = false;
			aiSb.scrollBy(Math.floor((aiSb.viewport.height || 10) / 2));
			logStore.logAiLastScrollTop = aiSb.scrollTop;
			return true;
		}
		if (event.ctrl && name === "u") {
			logStore.logAiAtBottom = false;
			aiSb.scrollBy(-Math.floor((aiSb.viewport.height || 10) / 2));
			logStore.logAiLastScrollTop = aiSb.scrollTop;
			return true;
		}
		if (event.ctrl && name === "g") {
			logStore.logAiAtBottom = false;
			aiSb.scrollTo(0);
			logStore.logAiLastScrollTop = 0;
			return true;
		}
		if (event.ctrl && name === "G") {
			logStore.logAiAtBottom = true;
			aiSb.scrollTo(aiSb.scrollHeight);
			logStore.logAiLastScrollTop = aiSb.scrollTop;
			return true;
		}
	}

	// ── Followup input: capture printable chars into the followup text field ──
	if (
		logStore.logAiVisible() &&
		logStore.logAiSummary() !== null &&
		!logStore.logAiLoading() &&
		!logStore.logAiStreaming()
	) {
		if (event.name === "return" || event.name === "enter") {
			const q = logStore.logAiFollowupText().trim();
			if (q) {
				logStore.setLogAiFollowupText("");
				void logActions.runAiAnalysis(q);
			}
			return true;
		}
		if (event.name === "backspace" || event.name === "delete") {
			logStore.setLogAiFollowupText((t) => t.slice(0, -1));
			return true;
		}
		const ch = event.sequence ?? event.name ?? "";
		if (ch.length === 1 && ch >= " ") {
			logStore.setLogAiFollowupText((t) => t + ch);
			return true;
		}
	}

	const sb = logStore.logScrollBoxRef;
	const lineCount = logStore.logs().split("\n").length;
	const _maxLine = Math.max(0, lineCount - 1);

	// ── Viewport scrolling (no cursor line) ───────────────────────────────

	// j / Down — scroll viewport down by 1 line
	if (isDownKey(event)) {
		if (sb) sb.scrollBy(1);
		logActions.syncLogScroll();
		return true;
	}

	// k / Up — scroll viewport up by 1 line
	if (isUpKey(event)) {
		if (sb) sb.scrollBy(-1);
		logActions.syncLogScroll();
		return true;
	}

	// d — scroll down half viewport
	if (event.name === "d") {
		if (sb) sb.scrollBy(Math.floor((sb.viewport.height || 10) / 2));
		logActions.syncLogScroll();
		return true;
	}

	// u — scroll up half viewport
	if (event.name === "u") {
		if (sb) sb.scrollBy(-Math.floor((sb.viewport.height || 10) / 2));
		logActions.syncLogScroll();
		return true;
	}

	// g — go to top
	if (event.name === "g" && !event.shift) {
		if (sb) sb.scrollTo(0);
		logActions.syncLogScroll();
		return true;
	}

	// G — go to bottom
	if (event.name === "G" || (event.name === "g" && event.shift)) {
		if (sb) sb.scrollTo(sb.scrollHeight);
		logActions.syncLogScroll();
		return true;
	}

	if (handleHorizontalScrollKey(event, sb)) return true;

	// / — enter search mode
	if (event.sequence === "/" || event.name === "/") {
		logStore.setLogSearchMode(true);
		logStore.setLogSearchQuery("");
		logStore.setLogSearchMatchIndex(-1);
		return true;
	}

	// n — jump to next search match (scrolls directly, no cursor)
	if (
		(event.name === "n" || event.sequence === "n") &&
		logStore.logSearchMatchLinesList().length > 0
	) {
		const matches = logStore.logSearchMatchLinesList();
		const next = (logStore.logSearchMatchIndex() + 1) % matches.length;
		logStore.setLogSearchMatchIndex(next);
		const line = matches[next];
		scrollToLogLine(line);
		logActions.syncLogScroll();
		return true;
	}

	// p — jump to previous search match (scrolls directly, no cursor)
	if (
		(event.name === "p" || event.sequence === "p") &&
		logStore.logSearchMatchLinesList().length > 0
	) {
		const matches = logStore.logSearchMatchLinesList();
		const prev =
			(logStore.logSearchMatchIndex() - 1 + matches.length) % matches.length;
		logStore.setLogSearchMatchIndex(prev);
		const line = matches[prev];
		scrollToLogLine(line);
		logActions.syncLogScroll();
		return true;
	}

	// Block all other keys while modal is open
	return true;
}
