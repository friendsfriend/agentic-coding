/** @jsxImportSource @opentui/solid */

import { type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, For, Show } from "solid-js";
import { parseMarkdownBlocks } from "../devenv-ui/markdownBlocks";
import { uiColors } from "./colors";
import { GenericModal } from "./GenericModal";
import { ScrollableContent } from "./ScrollableContent";

export function VerdictModal(props: {
	title: string;
	content: string;
	offset: number;
	lines: number;
	/**
	 * Opt-in block-level Markdown rendering for OpenSpec artifact content.
	 * Other callers (verifier verdicts, the Tasks list) keep the plain
	 * highlighted-source presentation.
	 */
	renderMarkdown?: boolean;
}) {
	const dimensions = useTerminalDimensions();
	const contentWidth = () =>
		Math.max(40, Math.floor(dimensions().width * 0.7) - 8);
	const syntaxStyle = SyntaxStyle.create();
	const blocks = createMemo(() =>
		props.renderMarkdown ? parseMarkdownBlocks(props.content) : [],
	);
	let scrollbox: ScrollBoxRenderable | undefined;
	createEffect(() => scrollbox?.scrollTo(props.offset));
	return (
		<GenericModal
			title={props.title}
			widthPercent={0.7}
			heightPercent={0.75}
			help={[
				{ key: "j/k", action: "Scroll" },
				{ key: "Esc", action: "Close" },
			]}
		>
			<ScrollableContent
				onScrollBoxReady={(box) => {
					scrollbox = box;
				}}
			>
				<Show
					when={props.renderMarkdown}
					fallback={
						<code
							filetype="markdown"
							content={props.content}
							syntaxStyle={syntaxStyle}
							fg={uiColors.textSecondary}
							width={contentWidth()}
						/>
					}
				>
					{/* Whole-document block-level Markdown so multi-line constructs
					    (lists, tables, block quotes, fenced code) render as blocks. */}
					<box paddingLeft={1} paddingRight={1}>
						<For each={blocks()}>
							{(block) => (
								<box flexDirection="row">
									<text
										fg={uiColors.textMuted}
										flexShrink={0}
										width={6}
									>
										{block.endLine > block.startLine
											? `${String(block.startLine)}-${String(block.endLine)}`
											: String(block.startLine)}
									</text>
									<markdown
										content={block.source}
										syntaxStyle={syntaxStyle}
										fg={uiColors.textSecondary}
										width={contentWidth()}
										flexGrow={1}
									/>
								</box>
							)}
						</For>
					</box>
				</Show>
			</ScrollableContent>
		</GenericModal>
	);
}