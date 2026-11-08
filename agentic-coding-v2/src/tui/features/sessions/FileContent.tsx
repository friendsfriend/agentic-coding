/** @jsxImportSource @opentui/solid */
import { RGBA, type SyntaxStyle } from "@opentui/core";
import { createContext, createSignal, For, Show, useContext } from "solid-js";
import { uiColors } from "../../presentation/theme/colors.ts";
import { SuppliedCode } from "./SuppliedCode.tsx";

/** Original tool surface hover: the card owns its header, padding and file. */
export const ToolSurfaceHoverContext = createContext<() => boolean>(
	() => false,
);

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

/** Original TranscriptFile body, bound only to retained/requested native bytes.
 * No filesystem reads, synthesized patches, apply controls or syntax ownership.
 * Non-diff source uses bounded local windows; patches stay intact. */
export function FileContent(props: {
	path: string;
	content: string;
	syntax: SyntaxStyle;
	diff?: boolean;
	startLine?: number;
	label: string;
}) {
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
	const filetype = () => {
		const extension = props.path
			.split("/")
			.at(-1)
			?.split(".")
			.at(-1)
			?.toLowerCase();
		const aliases: Record<string, string> = {
			ts: "typescript",
			tsx: "tsx",
			js: "javascript",
			jsx: "javascript",
			mjs: "javascript",
			cjs: "javascript",
			mts: "typescript",
			cts: "typescript",
			py: "python",
			rs: "rust",
			sh: "bash",
			zsh: "bash",
			yml: "yaml",
			md: "markdown",
		};
		return extension ? (aliases[extension] ?? extension) : undefined;
	};
	// OpenTUI's diff renderer displays only the first parsed file. Keep other
	// native diff formats and multi-file bytes readable instead of hiding them.
	const unified = () =>
		/(^|\n)@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(props.content) &&
		(props.content.match(/^--- /gm)?.length ?? 0) <= 1 &&
		(props.content.match(/^diff --git /gm)?.length ?? 0) <= 1 &&
		(props.content.match(/^Index: /gm)?.length ?? 0) <= 1;
	return (
		<box flexDirection="column" gap={1}>
			<text fg={uiColors.textMuted}>
				{props.label} · {props.path}
				{props.startLine === undefined
					? ""
					: ` · requested start line ${props.startLine}`}
			</text>
			<box
				width="100%"
				flexDirection="column"
				onSizeChange={function () {
					setWidth(this.width);
				}}
			>
				<Show
					when={props.diff}
					fallback={
						<SuppliedCode
							identity={`${props.path}:${props.label}`}
							content={props.content}
							filetype={filetype()}
							syntax={props.syntax}
							fg={uiColors.textPrimary}
							lineNumberFg={uiColors.textMuted}
							lineNumbers
							startLine={props.startLine}
						/>
					}
				>
					<Show
						when={unified()}
						fallback={
							<box flexDirection="column">
								<text fg={uiColors.textMuted}>
									Retained diff bytes — not a single unified patch; no patch is
									synthesized.
								</text>
								<For each={props.content.split("\n")}>
									{(line) => (
										<text
											wrapMode="word"
											fg={
												line.startsWith("+++") ||
												line.startsWith("---") ||
												line.startsWith("@@")
													? uiColors.textMuted
													: line.startsWith("+")
														? uiColors.diffAdded
														: line.startsWith("-")
															? uiColors.diffRemoved
															: uiColors.textPrimary
											}
										>
											{line || " "}
										</text>
									)}
								</For>
							</box>
						}
					>
						<diff
							diff={props.content}
							view={width() > 120 ? "split" : "unified"}
							showLineNumbers
							filetype={filetype()}
							syntaxStyle={props.syntax}
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
				</Show>
			</box>
		</box>
	);
}
