/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createEffect, createMemo, For, Show } from "solid-js";
import { GenericModal } from "../components/GenericModal.tsx";
import { formatHelpTextLines } from "../components/HelpText.tsx";
import { MarkdownBlockView } from "../components/MarkdownViewer.tsx";
import {
	blockSelectionToLines,
	type MarkdownBlock,
	parseMarkdownBlocks,
} from "../components/markdownBlocks.ts";
import { ScrollableContent } from "../components/ScrollableContent.tsx";
import { SearchHeader } from "../components/SearchHeader.tsx";
import { uiColors } from "../theme/colors";
import { DiscussionThread, formatTimestamp } from "./annotations.tsx";
import type { Discussion } from "./types.ts";

export interface MarkdownReviewViewProps {
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
	/**
	 * Render as a page instead of a dialog (the shell's wiki note page): the
	 * view fills the host's content area — no centered dialog box, no backdrop
	 * and no footer hint row, because the host chrome already carries the page
	 * name and the shell footer the keybinds.
	 */
	page?: boolean;
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
export function MarkdownReviewView(props: MarkdownReviewViewProps) {
	const renderer = useRenderer();

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

	createEffect(() => {
		const blockList = parsedBlocks();
		const commentIndices = blockList.flatMap((block, index) => {
			return getCommentsForBlock(block).length ? [index] : [];
		});
		props.onDiscussionLineIndicesChange?.(commentIndices);
		props.onSelectableLineCountChange?.(blockList.length);

		const range = blockSelectionToLines(
			blockList,
			props.visualModeActive ? props.visualModeStart : props.selectedLine,
			props.selectedLine,
		);
		props.onSelectedSourceRangeChange?.(range.start, range.end);

		// Auto-scroll when selected block changes.
		const next = props.selectedLine;

		// Wrap around if out of bounds
		if (next >= blockList.length && blockList.length > 0) {
			props.onSelectedLineChange(0);
			return;
		}
		if (next < 0 && blockList.length > 0) {
			props.onSelectedLineChange(blockList.length - 1);
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

	const blocks = () => (
		<ScrollableContent
			axes={["x", "y"]}
			keyboardAxes={["x"]}
			onScrollBoxReady={(r) => {
				scrollBox = r;
				props.onScrollBoxReady?.(r);
			}}
		>
			<box paddingLeft={props.page ? 0 : 2} paddingRight={props.page ? 0 : 2}>
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
									<MarkdownBlockView
										source={block.source}
										fg={fgColor()}
										width={Math.max(20, Math.floor(renderer.width * 0.7))}
										flexGrow={1}
									/>
								</box>

								{/* Render inline comments for this block */}
								<Show when={getCommentsForBlock(block).length > 0}>
									<For each={getCommentsForBlock(block)}>
										{(discussion) => (
											<DiscussionThread
												discussion={discussion}
												outdated={false}
												collapsed={false}
												formatTimestamp={formatTimestamp}
												paddingLeft={8}
											/>
										)}
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
	);

	if (props.page)
		return (
			<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
				{customHeader()}
				{blocks()}
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
			{blocks()}
		</GenericModal>
	);
}
