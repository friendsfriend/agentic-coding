/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core";
import { uiColors, useMarkdownSyntaxStyle } from "@ui";
import { createContext, createSignal, Show, useContext } from "solid-js";
import { type ToolView, transcriptFiletype } from "./tool-views.ts";
import {
	estimateDiffRows,
	estimateTextRows,
	VirtualToolBody,
} from "./transcript-viewport.tsx";

/** The card owns hover, including its header, padding and nested file view. */
export const ToolSurfaceHoverContext = createContext<() => boolean>(
	() => false,
);

/** Apply the card's surface lift without losing a change's red/green tint. */
function liftedDiffColor(color: string): RGBA {
	const base = RGBA.fromHex(color);
	const resting = RGBA.fromHex(uiColors.bgMantle);
	const hovered = RGBA.fromHex(uiColors.bgHover);
	const lift = (value: number, from: number, to: number) =>
		Math.max(0, Math.min(1, value + to - from));
	return RGBA.fromValues(
		lift(base.r, resting.r, hovered.r),
		lift(base.g, resting.g, hovered.g),
		lift(base.b, resting.b, hovered.b),
		1,
	);
}

/** Native code/diff renderers share the transcript's theme and syntax cache.
 * File content is fully laid out; wheel events bubble to the transcript. */
export function TranscriptFile(props: { file: NonNullable<ToolView["file"]> }) {
	const syntaxStyle = useMarkdownSyntaxStyle();
	const hovered = useContext(ToolSurfaceHoverContext);
	const contextBg = () =>
		hovered() ? uiColors.bgHover : uiColors.diffContextBg;
	const addedBg = () =>
		hovered() ? liftedDiffColor(uiColors.diffAddedBg) : uiColors.diffAddedBg;
	const removedBg = () =>
		hovered()
			? liftedDiffColor(uiColors.diffRemovedBg)
			: uiColors.diffRemovedBg;
	const [width, setWidth] = createSignal(0);
	return (
		<VirtualToolBody
			cacheKey={`${props.file.kind}\u0000${props.file.content}`}
			estimateHeight={(columns) =>
				props.file.kind === "diff"
					? estimateDiffRows(props.file.content, columns)
					: estimateTextRows(
							props.file.content,
							columns -
								Math.max(
									3,
									String(
										(props.file.startLine ?? 1) +
											props.file.content.split("\n").length -
											1,
									).length,
								) -
								1,
						)
			}
		>
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
						addedBg={addedBg()}
						removedBg={removedBg()}
						contextBg={contextBg()}
						addedSignColor={uiColors.diffAdded}
						removedSignColor={uiColors.diffRemoved}
						lineNumberFg={uiColors.textMuted}
						lineNumberBg={contextBg()}
						addedLineNumberBg={addedBg()}
						removedLineNumberBg={removedBg()}
					/>
				</Show>
			</box>
		</VirtualToolBody>
	);
}
