/** @jsxImportSource @opentui/solid */
import { uiColors, useMarkdownSyntaxStyle } from "@ui";
import { createSignal, Show } from "solid-js";
import { type ToolView, transcriptFiletype } from "./tool-views.ts";

/** Native code/diff renderers share the transcript's theme and syntax cache.
 * The parent clips the compact view, never the underlying source or diff. */
export function TranscriptFile(props: { file: NonNullable<ToolView["file"]> }) {
	const syntaxStyle = useMarkdownSyntaxStyle();
	const [width, setWidth] = createSignal(0);
	return (
		<box
			width="100%"
			flexDirection="column"
			onSizeChange={function () {
				setWidth(this.width);
			}}
		>
			<Show
				when={props.file.kind === "diff"}
				fallback={
					<line_number
						fg={uiColors.textMuted}
						minWidth={3}
						paddingRight={1}
						lineNumberOffset={(props.file.startLine ?? 1) - 1}
					>
						<code
							content={props.file.content}
							filetype={transcriptFiletype(props.file.path)}
							syntaxStyle={syntaxStyle}
							drawUnstyledText
							fg={uiColors.textPrimary}
							wrapMode="word"
						/>
					</line_number>
				}
			>
				<diff
					diff={props.file.content}
					view={width() > 120 ? "split" : "unified"}
					showLineNumbers
					filetype={transcriptFiletype(props.file.path)}
					syntaxStyle={syntaxStyle}
					wrapMode="word"
					fg={uiColors.textPrimary}
					addedBg={uiColors.diffAddedBg}
					removedBg={uiColors.diffRemovedBg}
					contextBg={uiColors.diffContextBg}
					addedSignColor={uiColors.diffAdded}
					removedSignColor={uiColors.diffRemoved}
					lineNumberFg={uiColors.textMuted}
					lineNumberBg={uiColors.diffContextBg}
					addedLineNumberBg={uiColors.diffAddedBg}
					removedLineNumberBg={uiColors.diffRemovedBg}
				/>
			</Show>
		</box>
	);
}
