/** @jsxImportSource @opentui/solid */
import {
	type ScrollBoxRenderable,
	SyntaxStyle,
	TextAttributes,
} from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createEffect, createMemo, For, Show } from "solid-js";
import { uiColors } from "../colors";
import {
	blockSelectionToLines,
	type MarkdownBlock,
	parseMarkdownBlocks,
} from "../markdownBlocks";
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

/**
 * MarkdownViewModal - presentational block-level markdown viewer.
 *
 * Mirrors DiffViewModal for the plan review gate: selectable rows, visual
 * range selection, inline comment threads, and a comment input row. The whole
 * artifact document is rendered as block-level Markdown: each top-level block
 * (heading, paragraph, list, table, block quote, fenced code) is one selectable
 * row mapped to the source-line range it was parsed from, so multi-line
 * constructs render as real Markdown while comments keep anchoring to source
 * lines. Keyboard handling lives in the parent (App.tsx) via the
 * `plan-review` keymap layer.
 */
export function MarkdownViewModal(props: MarkdownViewModalProps) {
	const renderer = useRenderer();
	const syntaxStyle = SyntaxStyle.create();

	let scrollBox: ScrollBoxRenderable;

	const dimensions = () => ({
		width: renderer.width,
		height: renderer.height,
	});

	const isCommentMode = createMemo(() => props.commentMode);

	// Every top-level block of the artifact is a selectable row.
	const parsedBlocks = createMemo(() => parseMarkdownBlocks(props.content));

	const isInVisualSelection = (blockIndex: number): boolean => {
		if (!props.visualModeActive) return false;
		const start = Math.min(props.visualModeStart, props.selectedLine);
		const end = Math.max(props.visualModeStart, props.selectedLine);
		return blockIndex >= start && blockIndex <= end;
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

	const getCommentsForBlock = (block: MarkdownBlock): Discussion[] => {
		const seen = new Set<string>();
		const matches: Discussion[] = [];
		for (let line = block.startLine; line <= block.endLine; line++) {
			for (const discussion of commentIndex().get(`line:${line}`) ?? []) {
				if (seen.has(discussion.id)) continue;
				seen.add(discussion.id);
				matches.push(discussion);
			}
		}
		return matches;
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
		const blocks = parsedBlocks();
		const commentIndices = blocks.flatMap((block, index) => {
			return getCommentsForBlock(block).length ? [index] : [];
		});
		props.onDiscussionLineIndicesChange?.(commentIndices);
		props.onSelectableLineCountChange?.(blocks.length);

		const range = blockSelectionToLines(
			blocks,
			props.visualModeActive ? props.visualModeStart : props.selectedLine,
			props.selectedLine,
		);
		props.onSelectedSourceRangeChange?.(range.start, range.end);

		// Auto-scroll when selected block changes.
		const next = props.selectedLine;

		// Wrap around if out of bounds
		if (next >= blocks.length && blocks.length > 0) {
			props.onSelectedLineChange(0);
			return;
		}
		if (next < 0 && blocks.length > 0) {
			props.onSelectedLineChange(blocks.length - 1);
			return;
		}

		if (!scrollBox) return;

		const wrapperBox = scrollBox.getChildren()[0];
		if (!wrapperBox) return;

		const target = wrapperBox.getChildren().find((child) => {
			return child.id === `block-${next}`;
		});

		if (!target) return;

		const following = wrapperBox
			.getChildren()
			.find((child) => child.id === `block-${next + 1}`);
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
					<For each={parsedBlocks()}>
						{(block, index) => {
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

							const lineLabel = () =>
								block.endLine > block.startLine
									? `${String(block.startLine)}-${String(block.endLine)}`
									: String(block.startLine);

							return (
								<>
									<box
										id={`block-${index()}`}
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
											width={8}
										>
											{lineLabel()}
										</text>
										<markdown
											content={block.source}
											syntaxStyle={syntaxStyle}
											fg={fgColor()}
											width={Math.max(20, Math.floor(renderer.width * 0.7))}
											flexGrow={1}
										/>
									</box>

									{/* Render inline comments for this block */}
									<Show when={getCommentsForBlock(block).length > 0}>
										<For each={getCommentsForBlock(block)}>
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

									{/* Show comment input inline after the selected block */}
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
