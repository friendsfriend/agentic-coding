/** @jsxImportSource @opentui/solid */

import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { Show } from "solid-js";
import { colors, uiColors } from "../colors";
import { getMarkdownSyntaxStyle } from "../markdownSyntax";
import { AnimatedStatusText } from "./AnimatedStatusText";
import { ScrollableContent } from "./ScrollableContent";

export interface LogAiOverlayProps {
	promptMode: boolean;
	promptText: string;
	loading: boolean;
	streaming: boolean;
	summary: string | null;
	error: string | null;
	followupText: string;
	onDismiss: () => void;
	onScrollBoxReady?: (scrollBox: ScrollBoxRenderable) => void;
}

export function LogAiOverlay(props: LogAiOverlayProps) {
	const dimensions = useTerminalDimensions();

	const overlayWidth = () => Math.floor(dimensions().width * 0.88);

	const boxHeight = () => {
		if (props.promptMode) return 5;
		if (props.error) return 5;
		if (props.summary !== null) return Math.max(10, dimensions().height - 10);
		if (props.loading || props.streaming) return 5;
		return 4;
	};

	return (
		<box
			position="absolute"
			top={2}
			left={Math.floor((dimensions().width - overlayWidth()) / 2)}
			width={overlayWidth()}
			height={boxHeight()}
			backgroundColor={uiColors.bgCrust}
			flexDirection="column"
			paddingLeft={2}
			paddingRight={2}
			paddingTop={1}
			paddingBottom={1}
		>
			<box
				flexDirection="row"
				justifyContent="space-between"
				flexShrink={0}
				height={1}
			>
				<box flexDirection="row" gap={1}>
					<text fg={colors.mauve} attributes={TextAttributes.BOLD}>
						✦ AI Analysis
					</text>
					<Show
						when={
							!props.loading &&
							!props.streaming &&
							!props.promptMode &&
							!props.error &&
							props.summary !== null
						}
					>
						<text fg={colors.green}>✓ done</text>
					</Show>
				</box>
				<box flexDirection="row" gap={2}>
					<Show when={props.summary !== null}>
						<text fg={uiColors.textMuted}>
							Ctrl+j/k scroll · Ctrl+g/G top/bottom
						</text>
					</Show>
					<text fg={uiColors.textMuted}>Esc dismiss</text>
				</box>
			</box>

			<Show when={props.promptMode}>
				<box flexDirection="column" flexShrink={0} marginTop={1}>
					<box flexDirection="row" height={1}>
						<text fg={uiColors.textMuted}>Prompt: </text>
						<text
							fg={props.promptText ? uiColors.textPrimary : uiColors.textMuted}
						>
							{props.promptText || "summarize errors and warnings..."}
						</text>
						<Show when={!props.loading}>
							<text fg={uiColors.primary}>█</text>
						</Show>
					</box>
					<box height={1} marginTop={1}>
						<text fg={uiColors.textMuted}>
							Enter to analyze · Esc to cancel
						</text>
					</box>
				</box>
			</Show>

			<Show
				when={
					(props.loading || props.streaming) &&
					!props.promptMode &&
					props.summary === null
				}
			>
				<box flexDirection="row" marginTop={1} height={1} alignItems="center">
					<AnimatedStatusText
						text={props.loading ? "Analyzing…" : "Generating…"}
						intent="ai"
						backgroundColor={uiColors.bgCrust}
					/>
				</box>
			</Show>

			<Show
				when={
					!props.promptMode &&
					!props.loading &&
					!props.streaming &&
					props.error !== null
				}
			>
				<box flexDirection="column" marginTop={1} flexShrink={0}>
					<box height={1}>
						<text fg={colors.red} attributes={TextAttributes.BOLD}>
							✗ Analysis failed
						</text>
					</box>
					<box height={1} marginTop={1}>
						<text fg={uiColors.textMuted}>{props.error ?? ""}</text>
					</box>
				</box>
			</Show>

			<Show
				when={
					!props.promptMode && props.error === null && props.summary !== null
				}
			>
				<ScrollableContent
					axes={["x", "y"]}
					keyboardAxes={["x"]}
					onScrollBoxReady={props.onScrollBoxReady}
					style={{ marginTop: 1 }}
				>
					<code
						filetype="markdown"
						content={props.summary ?? ""}
						syntaxStyle={getMarkdownSyntaxStyle()}
						drawUnstyledText={false}
						streaming={props.loading || props.streaming}
						fg={uiColors.textSecondary}
						width={Math.max(80, overlayWidth() - 4)}
					/>
				</ScrollableContent>
				<Show when={props.loading || props.streaming}>
					<box flexDirection="row" marginTop={1} height={1} alignItems="center">
						<AnimatedStatusText
							text="Generating…"
							intent="ai"
							backgroundColor={uiColors.bgCrust}
						/>
					</box>
				</Show>
				<box
					flexShrink={0}
					flexDirection="row"
					alignItems="center"
					marginTop={1}
					marginBottom={1}
					height={1}
				>
					<text fg={uiColors.textMuted}>❯ </text>
					<text
						fg={props.followupText ? uiColors.textPrimary : uiColors.textMuted}
					>
						{props.followupText || "Ask a followup question…"}
					</text>
					<Show when={!props.loading && !props.streaming}>
						<text fg={uiColors.primary}>█</text>
					</Show>
				</box>
			</Show>
		</box>
	);
}
