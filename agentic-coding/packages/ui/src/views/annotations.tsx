/** @jsxImportSource @opentui/solid */
// Annotation rendering shared by the review surfaces (diff and markdown).
//
// One mechanism: comments and review findings are both `Discussion` records, and
// both render through `DiscussionThread` — a finding differs only by its FIX
// marker and severity colour. `ReplyAffordance` is the one reply prompt/composer,
// shown when a surface supplies a reply handler.
import { TextAttributes } from "@opentui/core";
import { For, type JSX, Show } from "solid-js";
import { MarkdownViewer } from "../components/MarkdownViewer.tsx";
import { SelectionMarker } from "../components/SelectionMarker.tsx";
import { useTerminalDimensions } from "../hooks/useTerminalDimensions.ts";
import { uiColors } from "../theme/colors";
import type { Discussion } from "./types.ts";

export function ReplyAffordance(props: { active: boolean; text: string }) {
	return (
		<Show
			when={props.active}
			fallback={
				<box style={{ flexDirection: "row", gap: 1, paddingLeft: 4 }}>
					<text fg={uiColors.borderHighlight} attributes={TextAttributes.BOLD}>
						[r] Reply
					</text>
				</box>
			}
		>
			<box style={{ width: "100%", flexDirection: "row", gap: 1 }}>
				<box
					style={{ width: 4, flexDirection: "column", alignItems: "center" }}
				>
					<text fg={uiColors.primary}>●</text>
				</box>
				<box
					style={{
						flexGrow: 1,
						flexDirection: "row",
						paddingLeft: 1,
						paddingRight: 1,
					}}
					backgroundColor={uiColors.bgBase}
				>
					<text fg={uiColors.textPrimary}>
						{props.text || "Reply here..."}█
					</text>
				</box>
			</box>
		</Show>
	);
}

/**
 * A comment thread wrapped in the left-edge selection mark.
 *
 * `SelectionMarker` reserves its accent strip and gap in both states, so the
 * thread content keeps its column and only the accent paint changes with the
 * thread's anchor row: the cursor row gets the accent mark, a row inside the
 * visual range gets the range paint.
 */
export function MarkedThread(props: {
	selected?: boolean;
	range?: boolean;
	children: JSX.Element;
}) {
	return (
		<box flexDirection="row" backgroundColor={uiColors.bgBase}>
			<SelectionMarker
				selected={props.selected === true}
				range={props.range === true}
			/>
			<box flexDirection="column" flexGrow={1}>
				{props.children}
			</box>
		</box>
	);
}

export function DiscussionThread(props: {
	discussion: Discussion;
	outdated: boolean;
	collapsed: boolean;
	formatTimestamp: (timestamp: string) => string;
	paddingLeft: number;
	/** Paint the left-edge selection mark beside the thread. */
	selected?: boolean;
	/** Paint the visual-range strip beside the thread (thread's row is in range). */
	range?: boolean;
	/** Reply affordance: only threads given a handler can be answered. */
	repliesEnabled?: boolean;
	replyActive?: boolean;
	replyText?: string;
}) {
	const notesCount = props.discussion.notes.length;
	const dimensions = useTerminalDimensions();
	const markdownWidth = () => Math.max(20, dimensions().width - 12);
	return (
		<MarkedThread selected={props.selected} range={props.range}>
			<box
				flexDirection="column"
				paddingTop={1}
				paddingBottom={1}
				paddingLeft={Math.max(0, props.paddingLeft - 3)}
				paddingRight={2}
			>
				{/* Header row with status badges */}
				<box flexDirection="row" gap={2} marginBottom={0.5}>
					<Show when={props.discussion.findingId}>
						<text
							fg={
								props.discussion.notes[0].resolved
									? uiColors.success
									: uiColors.warning
							}
							attributes={TextAttributes.BOLD}
						>
							{props.discussion.notes[0].resolved ? "☑ FIX" : "☐ FIX"}
						</text>
					</Show>
					<Show when={props.outdated}>
						<text fg={uiColors.warning} attributes={TextAttributes.BOLD}>
							⚠ OUTDATED
						</text>
					</Show>
					<Show when={props.discussion.notes[0].resolved}>
						<text fg={uiColors.success} attributes={TextAttributes.BOLD}>
							✓ Resolved
						</text>
					</Show>
					<Show when={!props.discussion.notes[0].resolved && !props.outdated}>
						<text fg={uiColors.warning} attributes={TextAttributes.BOLD}>
							● Open
						</text>
					</Show>
				</box>

				{/* Conversation Messages with Timeline */}
				<Show when={!props.collapsed}>
					<box flexDirection="column">
						<For each={props.discussion.notes}>
							{(note, noteIndex) => {
								const isLastNote = () =>
									noteIndex() === props.discussion.notes.length - 1;
								return (
									<box
										style={{
											width: "100%",
											flexDirection: "row",
											flexShrink: 0,
										}}
									>
										{/* Timeline Column */}
										<box
											style={{
												width: 4,
												flexDirection: "column",
												alignItems: "center",
												flexShrink: 0,
											}}
										>
											<box
												style={{
													width: 3,
													height: 1,
													justifyContent: "center",
													alignItems: "center",
												}}
											>
												<text fg={uiColors.primary}>●</text>
											</box>
											<Show when={!isLastNote()}>
												<box
													style={{
														width: 1,
														flexGrow: 1,
														flexDirection: "column",
													}}
												>
													{(() => {
														const bodyLength = note.body?.length || 0;
														const lines = Math.max(
															3,
															Math.ceil(bodyLength / 80) + 2,
														);
														return Array(lines)
															.fill(null)
															.map((_, _i) => (
																<text fg={uiColors.bgSurface1}>│</text>
															));
													})()}
												</box>
											</Show>
										</box>

										{/* Message Content */}
										<box
											style={{
												flexGrow: 1,
												flexDirection: "column",
												paddingLeft: 1,
												paddingBottom: 1.5,
											}}
										>
											<box flexDirection="row" gap={1}>
												<text
													fg={uiColors.textPrimary}
													attributes={TextAttributes.BOLD}
												>
													{note.author?.name || "Unknown"}
												</text>
												<text fg={uiColors.textMuted}>
													{props.formatTimestamp(note.created_at)}
												</text>
											</box>
											<box style={{ width: "100%", marginTop: 0.5 }}>
												<text fg={uiColors.textSecondary}>
													{props.discussion.findingId ? (
														<MarkdownViewer
															content={note.body || "(no content)"}
															width={markdownWidth()}
														/>
													) : (
														note.body || "(no content)"
													)}
												</text>
											</box>
										</box>
									</box>
								);
							}}
						</For>
					</box>
				</Show>

				<Show when={props.repliesEnabled && !props.collapsed}>
					<ReplyAffordance
						active={props.replyActive === true}
						text={props.replyText ?? ""}
					/>
				</Show>

				<Show when={props.collapsed}>
					<box flexDirection="row" gap={1} alignItems="center" marginBottom={1}>
						<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
							{props.discussion.notes[0].author?.name || "Unknown"}
						</text>
						<text fg={uiColors.textMuted}>
							{props.formatTimestamp(props.discussion.notes[0].created_at)}
						</text>
						<text
							fg={uiColors.borderHighlight}
							attributes={TextAttributes.BOLD}
						>
							[t] Show {notesCount} {notesCount === 1 ? "message" : "messages"}
						</text>
					</box>
				</Show>
			</box>
		</MarkedThread>
	);
}

/**
 * DiffViewModal component with line selection.
 *
 * Enhanced with vim-style navigation (j/k/up/down) and line selection.
 *
 * IMPORTANT: Due to OpenTUI limitation (only ONE useKeyboard hook works per app),
 * keyboard events are handled in the PARENT component (app-opentui.tsx) and
 * passed down via controlled props (selectedLine + onSelectedLineChange).
 *
 * Features:
 * - Line-by-line diff rendering with selection
 * - Controlled line selection from parent
 * - Auto-scroll to keep selected line visible
 * - Mouse support for line selection
 * - Theme-driven colors
 *
 * Navigation (handled in parent):
 * - j/k or up/down: Navigate lines
 * - h/l and left/right: Scroll horizontally
 * - [/]/K/J: Navigate files
 * - ESC: Close modal
 */

/** Relative age used by every annotation header. */
export function formatTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (!timestamp || Number.isNaN(date.getTime())) return "N/A";
	const diffMins = Math.floor((Date.now() - date.getTime()) / 60000);
	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays < 7) return `${diffDays}d ago`;
	return date.toLocaleDateString();
}
