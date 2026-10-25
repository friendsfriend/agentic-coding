/** @jsxImportSource @opentui/solid */
import {
	CodeRenderable,
	type MouseEvent,
	type Renderable,
	RGBA,
} from "@opentui/core";
import { uiColors, useMarkdownSyntaxStyle } from "@ui";
import { createContext, createSignal, Show, useContext } from "solid-js";
import { type ToolView, transcriptFiletype } from "./tool-views.ts";

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
	);
}
