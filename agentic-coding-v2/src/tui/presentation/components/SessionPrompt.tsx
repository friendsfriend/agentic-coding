/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { createEffect, type JSX, Show } from "solid-js";
import { uiColors } from "../theme/colors.ts";
import type { RowGestureState } from "./mouse/useRowMouse.ts";
import { useTap } from "./mouse/useTap.ts";
import { PromptPulse } from "./PromptPulse.tsx";

/** Prompt chrome extracted from the original AgentSessionView. The editor,
 * draft, command routing and admission remain with the native shell. */
export function SessionPrompt(props: {
	children: JSX.Element;
	role: string;
	model?: string | null;
	thinking?: string | null;
	working: boolean;
	error?: boolean;
	meter?: string;
	scope?: unknown;
	interactive?: boolean;
	onModel?: () => void;
	onThinking?: () => void;
}) {
	const modelGesture: RowGestureState = {},
		thinkingGesture: RowGestureState = {};
	createEffect(() => {
		// A header press belongs to this view and these exact observed labels.
		props.scope;
		props.model;
		props.thinking;
		props.interactive;
		for (const gesture of [modelGesture, thinkingGesture]) {
			gesture.down = undefined;
			gesture.lastTap = undefined;
		}
	});
	const modelTap = useTap(() => props.onModel?.(), {
		gesture: modelGesture,
		stopPropagation: true,
		enabled: () => props.interactive === true && props.onModel !== undefined,
	});
	const thinkingTap = useTap(() => props.onThinking?.(), {
		gesture: thinkingGesture,
		stopPropagation: true,
		enabled: () => props.interactive === true && props.onThinking !== undefined,
	});
	const model = () => {
		const value = props.model ?? "";
		return value.length > 32 ? `${value.slice(0, 31)}…` : value;
	};
	return (
		<box
			border={["left"]}
			borderColor={uiColors.accent}
			flexShrink={0}
			backgroundColor={uiColors.bgMantle}
		>
			<PromptPulse
				active={props.working}
				error={props.error && !props.working}
			/>
			<box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2}>
				{props.children}
				<box flexDirection="row" gap={1} paddingTop={1} alignItems="center">
					<text fg={uiColors.accent} flexShrink={0}>
						{props.role}
					</text>
					<Show when={props.model}>
						<text fg={uiColors.textMuted} flexShrink={0}>
							·
						</text>
						<text
							{...modelTap}
							fg={uiColors.textPrimary}
							flexShrink={1}
							minWidth={0}
							wrapMode="none"
							truncate
						>
							{model()}
						</text>
					</Show>
					<Show when={props.thinking}>
						<text fg={uiColors.textMuted} flexShrink={0}>
							·
						</text>
						<text
							{...thinkingTap}
							fg={uiColors.warning}
							attributes={TextAttributes.BOLD}
							flexShrink={0}
						>
							{props.thinking}
						</text>
					</Show>
					<box flexGrow={1} minWidth={0} />
					<Show when={props.meter}>
						<text fg={uiColors.textMuted} flexShrink={0} wrapMode="none">
							{props.meter}
						</text>
					</Show>
				</box>
			</box>
		</box>
	);
}
