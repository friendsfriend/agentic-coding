/** @jsxImportSource @opentui/solid */

import type { TextChunk } from "@opentui/core";
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, For, type JSX, Show } from "solid-js";
import { ansiToStyledText, stripAnsi } from "../ansiToStyledText";
import { uiColors } from "../colors";
import { GenericModal } from "./GenericModal";
import { formatHelpText } from "./HelpText";
import { highlightColor } from "./Highlight";
import { LogAiOverlay } from "./LogAiOverlay";
import { ScrollableContent } from "./ScrollableContent";
import { SearchHeader } from "./SearchHeader";

export interface LogModalProps {
	/** Modal title / header label (e.g. "Container Logs: my-app (auto-refresh: 10s)") */
	title: string;
	/** Raw log text — newline-separated */
	logs: string;
	/** Optional pre-split log lines. Avoids splitting large logs every render. */
	logLines?: readonly string[];
	/** When set, renders custom children instead of line-by-line log text. Parent owns search/filter. */
	children?: JSX.Element;
	historyLoading?: boolean;
	historyHasMore?: boolean;
	historyError?: string | null;
	/**
	 * Called once on mount with the ScrollBoxRenderable so the parent can call
	 * scrollBy / scrollTo directly (same imperative pattern as DiffViewModal).
	 */
	onScrollBoxReady: (scrollBox: ScrollBoxRenderable) => void;
	onClose: () => void;

	// scrollTop / viewportHeight intentionally omitted (OpenTUI built-in viewportCulling handles it)
	// Mouse selection works natively; no cursor line / visual mode.

	// ── Search ──────────────────────────────────────────────────────────────
	/** Whether the user is currently typing a search query (/ was pressed). */
	searchMode: boolean;
	/** Current search string (empty = no active search). */
	searchQuery: string;
	/**
	 * Set of line indices that contain at least one match.
	 * All matches are highlighted; the "current" match line gets a distinct colour.
	 */
	searchMatchLines: ReadonlySet<number>;
	/** Index into the match list that is the "current" (focused) match. -1 = none. */
	searchMatchIndex: number;
	/**
	 * Ordered list of matching line indices (same order as the match list).
	 * Used so we can look up which line corresponds to searchMatchIndex.
	 */
	searchMatchLinesList: readonly number[];

	// ── AI analysis overlay ─────────────────────────────────────────────────
	/** True while the user is typing the optional AI prompt (Shift+A pressed). */
	aiPromptMode: boolean;
	/** Text the user has typed so far for the AI prompt. */
	aiPromptText: string;
	/** True while waiting for the AI analysis response. */
	aiLoading: boolean;
	aiStreaming: boolean;
	/** The AI summary text once available, or null when not yet requested / dismissed. */
	aiSummary: string | null;
	aiError: string | null;
	/** Whether the AI overlay is currently visible (independent of state). */
	aiVisible: boolean;
	/** Called when the user presses Esc inside the AI overlay to dismiss it. */
	onAiDismiss: () => void;
	onAiScrollBoxReady?: (scrollBox: ScrollBoxRenderable) => void;
	/** Text currently typed in the followup input field. */
	aiFollowupText: string;
}

// ── helpers ────────────────────────────────────────────────────────────────

function chunkStyle(chunk: TextChunk): Record<string, unknown> {
	const attrs = chunk.attributes ?? 0;
	return {
		...(chunk.fg && { fg: chunk.fg }),
		...(chunk.bg && { bg: chunk.bg }),
		...(attrs & TextAttributes.BOLD && { bold: true }),
		...(attrs & TextAttributes.ITALIC && { italic: true }),
		...(attrs & TextAttributes.UNDERLINE && { underline: true }),
		...(attrs & TextAttributes.DIM && { dim: true }),
		...(attrs & TextAttributes.BLINK && { blink: true }),
		...(attrs & TextAttributes.INVERSE && { reverse: true }),
		...(attrs & TextAttributes.STRIKETHROUGH && { strikethrough: true }),
	};
}

/**
 * Split `text` into alternating [non-match, match, non-match, …] segments for
 * the given (lowercased) query. Returns an array of { text, isMatch } tuples.
 */
function splitMatches(
	text: string,
	query: string,
): Array<{ text: string; isMatch: boolean }> {
	if (!query) return [{ text, isMatch: false }];
	const lower = text.toLowerCase();
	const segments: Array<{ text: string; isMatch: boolean }> = [];
	let pos = 0;
	while (pos < text.length) {
		const idx = lower.indexOf(query, pos);
		if (idx === -1) {
			segments.push({ text: text.slice(pos), isMatch: false });
			break;
		}
		if (idx > pos) {
			segments.push({ text: text.slice(pos, idx), isMatch: false });
		}
		segments.push({ text: text.slice(idx, idx + query.length), isMatch: true });
		pos = idx + query.length;
	}
	return segments;
}

// ── component ──────────────────────────────────────────────────────────────

/**
 * LogModal — scrollable log viewer rendered as a full-height popup overlay.
 *
 * - Pure presentational component, no useKeyboard hook.
 * - Scrolling driven imperatively by parent via scrollBy/scrollTo on the
 *   ScrollBoxRenderable exposed through onScrollBoxReady.
 * - Uses GenericModal for consistent backdrop + sizing.
 * - Starts at the bottom via stickyScroll/stickyStart="bottom".
 * - No cursor line or visual mode — viewport scrolling with j/k/d/u/g/G.
 * - Search mode: / opens inline query bar; matches highlighted in yellow;
 *   n/p navigate between matches.
 */
export function LogModal(props: LogModalProps) {
	const renderer = useRenderer();
	const dimensions = () => ({
		width: renderer.width,
		height: renderer.height,
	});

	const lines = createMemo(() =>
		props.logLines ? [...props.logLines] : props.logs.split("\n"),
	);
	const lineCount = () => lines().length;

	// All lines are passed to <For>; OpenTUI viewportCulling handles off-screen clipping.

	const isCurrentSearchMatch = (index: number): boolean => {
		if (props.searchMatchIndex < 0) return false;
		return props.searchMatchLinesList[props.searchMatchIndex] === index;
	};

	// ── header ──────────────────────────────────────────────────────────────

	const matchCount = () => props.searchMatchLines.size;

	const customHeader = () => (
		<SearchHeader
			searchMode={props.searchMode}
			searchQuery={props.searchQuery}
			resultCount={matchCount()}
		>
			<box
				flexDirection="row"
				justifyContent="space-between"
				alignItems="center"
				style={{ width: "100%" }}
			>
				<text fg={highlightColor("primary")}>
					<b>{props.title}</b>
				</text>
				<text fg={highlightColor("secondary")}>
					{props.historyLoading ? "loading older… • " : ""}
					{String(lineCount())} lines
					{props.historyHasMore ? " • older logs available" : ""}
				</text>
			</box>
		</SearchHeader>
	);

	// ── keybind help text (standard modal style: plain string via formatHelpText) ──

	const keybinds = () =>
		props.searchMode
			? formatHelpText([
					{ key: "Enter", action: "Confirm search" },
					{ key: "Backspace", action: "Delete char" },
					{ key: "Esc", action: "Cancel search" },
				])
			: formatHelpText([
					{ key: "/", action: "Search" },
					{ key: "n/p", action: "Next/Prev match" },
					{ key: "e", action: "Open in editor" },
					{ key: "Shift+E", action: "Choose editor" },
					{ key: "A", action: "AI analysis" },
					{ key: "Esc", action: "Close" },
				]);

	// ── render ──────────────────────────────────────────────────────────────

	return (
		<>
			<GenericModal
				title=""
				helpText={keybinds()}
				widthPercent={0.92}
				heightPercent={(dimensions().height - 4) / dimensions().height}
				customHeader={customHeader()}
				onBackdropClick={props.onClose}
			>
				<ScrollableContent
					axes={["x", "y"]}
					keyboardAxes={["x"]}
					onScrollBoxReady={(r) => {
						props.onScrollBoxReady(r);
					}}
					viewportCulling={true}
					stickyScroll={true}
					stickyStart="bottom"
				>
					<box paddingLeft={1} paddingRight={1}>
						<Show when={props.historyError}>
							<box
								flexDirection="row"
								style={{ flexShrink: 0, height: 1, minWidth: "100%" }}
							>
								<text fg={uiColors.warning}>
									Failed to load older logs: {props.historyError}
								</text>
							</box>
						</Show>
						<Show when={props.historyLoading}>
							<box
								flexDirection="row"
								style={{ flexShrink: 0, height: 1, minWidth: "100%" }}
							>
								<text fg={highlightColor("secondary")}>
									Loading older logs…
								</text>
							</box>
						</Show>
						<Show
							when={
								!props.historyLoading &&
								!props.historyHasMore &&
								lineCount() > 0
							}
						>
							<box
								flexDirection="row"
								style={{ flexShrink: 0, height: 1, minWidth: "100%" }}
							>
								<text fg={highlightColor("secondary")}>Start of log</text>
							</box>
						</Show>
						<Show when={!props.children} fallback={props.children}>
							<For each={lines()}>
								{(line, localIndex) => {
									const index = localIndex;
									const isMatchLine = () => props.searchMatchLines.has(index());
									const isCurrentMatch = () => isCurrentSearchMatch(index());

									const lineWidth = Math.max(stripAnsi(line).length, 1);
									const styledLine = ansiToStyledText(line);

									const query = () => props.searchQuery.toLowerCase();
									const hasSearch = () => query().length > 0 && isMatchLine();

									return (
										<box
											flexDirection="row"
											style={{
												flexShrink: 0,
												height: 1,
												minWidth: "100%",
												width: lineWidth,
											}}
										>
											<Show
												when={hasSearch()}
												fallback={
													styledLine ? (
														<text fg={highlightColor("primary")}>
															<For each={styledLine.chunks}>
																{(chunk) => (
																	<span style={chunkStyle(chunk)}>
																		{chunk.text}
																	</span>
																)}
															</For>
														</text>
													) : (
														<text fg={highlightColor("primary")}>{line}</text>
													)
												}
											>
												<For each={splitMatches(stripAnsi(line), query())}>
													{(seg) => (
														<Show
															when={seg.isMatch}
															fallback={
																<text fg={highlightColor("primary")}>
																	{seg.text}
																</text>
															}
														>
															<text
																fg={uiColors.bgBase}
																bg={
																	isCurrentMatch()
																		? uiColors.primary
																		: uiColors.warning
																}
															>
																{seg.text}
															</text>
														</Show>
													)}
												</For>
											</Show>
										</box>
									);
								}}
							</For>
						</Show>
					</box>
				</ScrollableContent>
			</GenericModal>
			<Show
				when={
					props.aiVisible &&
					(props.aiPromptMode ||
						props.aiLoading ||
						props.aiSummary !== null ||
						props.aiError !== null)
				}
			>
				<LogAiOverlay
					promptMode={props.aiPromptMode}
					promptText={props.aiPromptText}
					loading={props.aiLoading}
					streaming={props.aiStreaming}
					summary={props.aiSummary}
					error={props.aiError}
					followupText={props.aiFollowupText}
					onDismiss={props.onAiDismiss}
					onScrollBoxReady={props.onAiScrollBoxReady}
				/>
			</Show>
		</>
	);
}
