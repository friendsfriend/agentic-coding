/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { type JSX, Show } from "solid-js";
import { uiColors } from "../theme/colors.ts";
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
}) {
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
