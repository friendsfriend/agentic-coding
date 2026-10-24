/** @jsxImportSource @opentui/solid */
import {
	CodeRenderable,
	type MouseEvent,
	type Renderable,
} from "@opentui/core";
import { uiColors, useMarkdownSyntaxStyle } from "@ui";
import { createSignal, Show } from "solid-js";
import { type ToolView, transcriptFiletype } from "./tool-views.ts";

/** Code handles its own wheel before the event reaches the diff. Its gutters
 * are siblings of the code, so forward those wheels to both diff sides once. */
function ownDiffWheel(diff: Renderable, event: MouseEvent) {
	event.stopPropagation();
	let target = event.target;
	while (target && target !== diff) {
		if (target instanceof CodeRenderable) return;
		target = target.parent;
	}
	const direction = event.scroll?.direction;
	if (direction !== "up" && direction !== "down") return;
	const delta = (event.scroll?.delta ?? 0) * (direction === "up" ? -1 : 1);
	const scrollCode = (node: Renderable) => {
		if (node instanceof CodeRenderable) node.scrollY += delta;
		else for (const child of node.getChildren()) scrollCode(child);
	};
	scrollCode(diff);
}

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
					onMouseScroll={function (this: Renderable, event: MouseEvent) {
						// Own both directions even at an edge; the transcript only gets
						// wheels whose pointer is outside this diff's visible bounds.
						ownDiffWheel(this, event);
					}}
					diff={props.file.content}
					view={width() > 120 ? "split" : "unified"}
					showLineNumbers
					syncScroll
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
