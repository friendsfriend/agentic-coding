/** @jsxImportSource @opentui/solid */
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createEffect, createMemo, For, Show } from "solid-js";
import { uiColors } from "../colors";
import type { Discussion } from "../types";
import { GenericModal } from "./GenericModal";
import { formatHelpTextLines } from "./HelpText";
import { ScrollableContent } from "./ScrollableContent";
import { SearchHeader } from "./SearchHeader";

interface MarkdownViewModalProps {
	filePath: string;
	content: string;
	currentFileIndex: number;
	totalFiles: number;
	selectedLine: number; // Controlled from parent due to OpenTUI keyboard limitation
	visualModeActive: boolean; // Is visual selection mode active (v key)
	visualModeStart: number; // Starting line of visual selection
	commentMode: boolean; // Is comment input mode active
	commentText: string; // Current comment text being typed
	discussions?: Discussion[]; // Comment threads to display inline
	onSelectedLineChange: (line: number) => void; // Callback to update parent
	onSelectedSourceRangeChange?: (start?: number, end?: number) => void;
	onDiscussionLineIndicesChange?: (indices: number[]) => void;
	onSelectableLineCountChange?: (count: number) => void;
	onClose: () => void;
	onNavigateFile?: (direction: 1 | -1) => void;
	onScrollBoxReady?: (scrollBox: ScrollBoxRenderable) => void;
}

interface MarkdownLine {
	lineNumber: number; // 1-based line number in the artifact file
	content: string;
}

/**
 * MarkdownViewModal - presentational line-based markdown viewer.
 *
 * Mirrors DiffViewModal for the plan review gate: selectable rows, visual
 * range selection, inline comment threads, and a comment input row. Unlike
 * the diff view there is no diff parsing, split view, or finding markers —
 * every artifact line is a plain selectable row and comments anchor to file
 * line numbers. Keyboard handling lives in the parent (App.tsx) via the
 * `plan-review` keymap layer.
 */
export function MarkdownViewModal(props: MarkdownViewModalProps) {
	const renderer = useRenderer();

	let scrollBox: ScrollBoxRenderable;

	const dimensions = () => ({
		width: renderer.width,
		height: renderer.height,
	});

	const isCommentMode = createMemo(() => props.commentMode);

	// Every non-empty line of the artifact is a selectable row.
	const parsedLines = createMemo((): MarkdownLine[] => {
		const lines = props.content.split("\n");
		return lines.map((content, index) => ({
			lineNumber: index + 1,
			content,
		}));
	});

	const isInVisualSelection = (lineIndex: number): boolean => {
		if (!props.visualModeActive) return false;
		const start = Math.min(props.visualModeStart, props.selectedLine);
		const end = Math.max(props.visualModeStart, props.selectedLine);
		return lineIndex >= start && lineIndex <= end;
	};

	const commentIndex = createMemo(() => {
		const index = new Map<string, Discussion[]>();
		const add = (key: string, discussion: Discussion) => {
			const bucket = index.get(key);
			if (bucket) bucket.push(discussion);
			else index.set(key, [discussion]);
		};

		for (const discussion of props.discussions ?? []) {
			const position =
				discussion.position ||
				(discussion.notes && discussion.notes.length > 0
					? discussion.notes[0].position
					: null);
			if (!position) continue;
			if (position.new_line) add(`line:${position.new_line}`, discussion);
		}

		return index;
	});

	const getCommentsForLine = (line: MarkdownLine): Discussion[] => {
		return commentIndex().get(`line:${line.lineNumber}`) ?? [];
	};

	const formatTimestamp = (timestamp: string): string => {
		const date = new Date(timestamp);
		if (!timestamp || Number.isNaN(date.getTime())) return "N/A";
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);

		if (diffMins < 1) return "just now";
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;

		return date.toLocaleDateString();
	};

	createEffect(() => {
		const lines = parsedLines();
		const commentIndices = lines.flatMap((line, index) => {
			return getCommentsForLine(line).length ? [index] : [];
		});
		props.onDiscussionLineIndicesChange?.(commentIndices);
		props.onSelectableLineCountChange?.(lines.length);

		const selected = lines[props.selectedLine];
		const start = props.visualModeActive
			? lines[props.visualModeStart]
			: selected;
		const selectedSourceLine = selected?.lineNumber;
		const startSourceLine = start?.lineNumber;
		props.onSelectedSourceRangeChange?.(
			startSourceLine === undefined || selectedSourceLine === undefined
				? selectedSourceLine
				: Math.min(startSourceLine, selectedSourceLine),
			startSourceLine === undefined || selectedSourceLine === undefined
				? selectedSourceLine
				: Math.max(startSourceLine, selectedSourceLine),
		);

		// Auto-scroll when selected line changes.
		const next = props.selectedLine;

		// Wrap around if out of bounds
		if (next >= lines.length && lines.length > 0) {
			props.onSelectedLineChange(0);
			return;
		}
		if (next < 0 && lines.length > 0) {
			props.onSelectedLineChange(lines.length - 1);
			return;
		}

		if (!scrollBox) return;

		const wrapperBox = scrollBox.getChildren()[0];
		if (!wrapperBox) return;

		const target = wrapperBox.getChildren().find((child) => {
			return child.id === `line-${next}`;
		});

		if (!target) return;

		const following = wrapperBox
			.getChildren()
			.find((child) => child.id === `line-${next + 1}`);
		if (following) scrollBox.scrollChildIntoView(following.id);

		scrollBox.scrollChildIntoView(target.id);
	});

	const customHeader = () => (
		<SearchHeader>
			<box
				flexDirection="row"
				justifyContent="space-between"
				alignItems="center"
				style={{ width: "100%" }}
			>
				<box flexDirection="row" gap={1} alignItems="center">
					<text fg={uiColors.textPrimary}>
						<b>{props.filePath}</b>
					</text>
					<text fg={uiColors.textMuted}>
						{"(" +
							String(props.currentFileIndex + 1) +
							"/" +
							String(props.totalFiles) +
							")"}
					</text>
				</box>
				<box flexDirection="row" gap={1} alignItems="center">
					<Show when={props.visualModeActive}>
						<text fg={uiColors.warning}>VISUAL</text>
					</Show>
					<Show when={props.commentMode}>
						<text fg={uiColors.primary}>COMMENT</text>
					</Show>
				</box>
			</box>
		</SearchHeader>
	);

	const footerHelpLines = () =>
		formatHelpTextLines(
			props.commentMode
				? [
						{ key: "Type", action: "Comment" },
						{ key: "Enter", action: "Linebreak" },
						{ key: "Ctrl+Enter", action: "Submit" },
						{ key: "Esc", action: "Cancel" },
					]
				: [
						{ key: "j/k", action: "Nav" },
						{ key: "n/N", action: "Next/Prev" },
						{ key: "v", action: "Visual" },
						{ key: "c", action: "Comment" },
						{ key: "f", action: "Finish" },
						{ key: "Esc", action: "Close" },
					],
			Math.max(1, Math.floor(dimensions().width * 0.9) - 4),
		);

	const customFooter = () => (
		<box paddingTop={1} flexShrink={0} flexDirection="column">
			<For each={footerHelpLines()}>
				{(line) => <text fg={uiColors.textMuted}>{line}</text>}
			</For>
		</box>
	);

	return (
		<GenericModal
			title="" // Not used, using custom header instead
			helpText="" // Not used, using custom footer instead
			widthPercent={0.9}
			heightPercent={(dimensions().height - 4) / dimensions().height}
			customHeader={customHeader()}
			customFooter={customFooter()}
			onBackdropClick={props.onClose}
		>
			<ScrollableContent
				axes={["x", "y"]}
				keyboardAxes={["x"]}
				onScrollBoxReady={(r) => {
					scrollBox = r;
					props.onScrollBoxReady?.(r);
				}}
			>
				<box paddingLeft={2} paddingRight={2}>
					<For each={parsedLines()}>
						{(line, index) => {
							const isSelected = () => index() === props.selectedLine;
							const isInSelection = () => isInVisualSelection(index());

							const bgColor = () => {
								if (isSelected()) return uiColors.primary;
								if (isInSelection()) return uiColors.bgSurface2;
								return uiColors.bgBase;
							};

							const fgColor = () => {
								if (isSelected()) return uiColors.bgBase;
								if (isInSelection()) return uiColors.textPrimary;
								return uiColors.textPrimary;
							};

							return (
								<>
									<box
										id={`line-${index()}`}
										flexDirection="row"
										backgroundColor={bgColor()}
										paddingLeft={1}
										paddingRight={1}
										onMouseUp={() => {
											props.onSelectedLineChange(index());
										}}
									>
										<text
											fg={isSelected() ? uiColors.bgBase : uiColors.textMuted}
											flexShrink={0}
											width={6}
										>
											{String(line.lineNumber)}
										</text>
										<text fg={fgColor()} flexGrow={1}>
											{line.content || " "}
										</text>
									</box>

									{/* Render inline comments for this line */}
									<Show when={getCommentsForLine(line).length > 0}>
										<For each={getCommentsForLine(line)}>
											{(discussion) => {
												const _notesCount = discussion.notes.length;

												return (
													<box
														flexDirection="column"
														backgroundColor={uiColors.bgBase}
														paddingTop={1}
														paddingBottom={1}
														paddingLeft={8}
														paddingRight={2}
													>
														<box flexDirection="row" gap={2} marginBottom={0.5}>
															<Show when={discussion.notes[0].resolved}>
																<text
																	fg={uiColors.success}
																	attributes={TextAttributes.BOLD}
																>
																	✓ Resolved
																</text>
															</Show>
															<Show when={!discussion.notes[0].resolved}>
																<text
																	fg={uiColors.warning}
																	attributes={TextAttributes.BOLD}
																>
																	● Open
																</text>
															</Show>
														</box>

														<box flexDirection="column">
															<For each={discussion.notes}>
																{(note, noteIndex) => {
																	const isLastNote = () =>
																		noteIndex() === discussion.notes.length - 1;
																	return (
																		<box
																			style={{
																				width: "100%",
																				flexDirection: "row",
																				flexShrink: 0,
																			}}
																		>
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
																							const bodyLength =
																								note.body?.length || 0;
																							const lines = Math.max(
																								3,
																								Math.ceil(bodyLength / 80) + 2,
																							);
																							return Array(lines)
																								.fill(null)
																								.map((_, _i) => (
																									<text
																										fg={uiColors.bgSurface1}
																									>
																										│
																									</text>
																								));
																						})()}
																					</box>
																				</Show>
																			</box>

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
																						{formatTimestamp(note.created_at)}
																					</text>
																				</box>
																				<box
																					style={{
																						width: "100%",
																						marginTop: 0.5,
																					}}
																				>
																					<text fg={uiColors.textSecondary}>
																						{note.body || "(no content)"}
																					</text>
																				</box>
																			</box>
																		</box>
																	);
																}}
															</For>
														</box>
													</box>
												);
											}}
										</For>
									</Show>

									{/* Show comment input inline after the selected line */}
									{isCommentMode() && isSelected() ? (
										<box
											flexDirection="row"
											alignItems="center"
											gap={1}
											backgroundColor={uiColors.bgBase}
											paddingLeft={1}
											paddingRight={1}
											flexGrow={1}
										>
											<text fg={uiColors.textPrimary}>
												{String(props.commentText || "Comment here...")}█
											</text>
										</box>
									) : null}
								</>
							);
						}}
					</For>
				</box>
			</ScrollableContent>
		</GenericModal>
	);
}
