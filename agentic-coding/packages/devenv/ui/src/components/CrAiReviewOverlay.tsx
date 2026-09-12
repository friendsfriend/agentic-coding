/** @jsxImportSource @opentui/solid */

import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { Show } from "solid-js";
import { colors, uiColors } from "../colors";
import { getMarkdownSyntaxStyle } from "../markdownSyntax";
import { AnimatedStatusText } from "./AnimatedStatusText";
import { ScrollableContent } from "./ScrollableContent";

export interface CrAiReviewOverlayProps {
	loading: boolean;
	streaming: boolean;
	summary: string | null;
	error: string | null;
	onDismiss: () => void;
	onScrollBoxReady?: (scrollBox: ScrollBoxRenderable) => void;
}

export function CrAiReviewOverlay(props: CrAiReviewOverlayProps) {
	const renderer = useRenderer();
	const overlayWidth = () => Math.floor(renderer.width * 0.88);

	const boxHeight = () => {
		if (props.error)
			return Math.min(
				12,
				4 + Math.ceil(props.error.length / (overlayWidth() - 6)),
			);
		if (props.summary !== null) return Math.max(10, renderer.height - 10);
		if (props.loading || props.streaming) return 5;
		return 4;
	};

	return (
		<box
			position="absolute"
			top={2}
			left={Math.floor((renderer.width - overlayWidth()) / 2)}
			width={overlayWidth()}
			height={boxHeight()}
			backgroundColor={uiColors.bgCrust}
			flexDirection="column"
			paddingLeft={2}
			paddingRight={2}
			paddingTop={1}
			paddingBottom={1}
		>
			{/* Header */}
			<box
				flexDirection="row"
				justifyContent="space-between"
				flexShrink={0}
				height={1}
			>
				<box flexDirection="row" gap={1}>
					<text fg={colors.mauve} attributes={TextAttributes.BOLD}>
						✦ AI Review
					</text>
					<Show
						when={
							!props.loading &&
							!props.streaming &&
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

			<Show when={(props.loading || props.streaming) && props.summary === null}>
				<box flexDirection="row" marginTop={1} height={1} alignItems="center">
					<AnimatedStatusText
						text={props.loading ? "Spawning agent in worktree…" : "Reviewing…"}
						intent="ai"
						backgroundColor={uiColors.bgCrust}
					/>
				</box>
			</Show>

			{/* Error */}
			<Show when={!props.loading && !props.streaming && props.error !== null}>
				<box flexDirection="column" marginTop={1} flexShrink={0}>
					<box height={1}>
						<text fg={colors.red} attributes={TextAttributes.BOLD}>
							✗ Review failed
						</text>
					</box>
					<box marginTop={1} paddingRight={2}>
						<text fg={uiColors.textMuted}>{props.error ?? ""}</text>
					</box>
				</box>
			</Show>

			{/* Streaming / completed review */}
			<Show when={props.error === null && props.summary !== null}>
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
						drawUnstyledText={true}
						streaming={props.loading || props.streaming}
						fg={uiColors.textSecondary}
						width={Math.max(80, overlayWidth() - 4)}
					/>
				</ScrollableContent>

				<Show when={props.loading || props.streaming}>
					<box flexDirection="row" marginTop={1} height={1} alignItems="center">
						<AnimatedStatusText
							text="Agent working…"
							intent="ai"
							backgroundColor={uiColors.bgCrust}
						/>
					</box>
				</Show>

				{/* Footer */}
				<box
					flexShrink={0}
					flexDirection="row"
					alignItems="center"
					marginTop={1}
					height={1}
				>
					<Show when={!props.loading && !props.streaming}>
						<text fg={uiColors.textMuted}>Enter close · Esc dismiss</text>
					</Show>
				</box>
			</Show>
		</box>
	);
}
