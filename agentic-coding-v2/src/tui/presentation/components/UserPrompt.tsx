/** @jsxImportSource @opentui/solid */

import { uiColors } from "../theme/colors.ts";
import { useHover } from "./mouse/useHover.ts";
import { useTap } from "./mouse/useTap.ts";
import { Stamp } from "./Stamp.tsx";

/** Original UserPrompt presentation, with text/folding supplied by the native
 * caller instead of the legacy AgentSessionBlock contract. */
export function UserPrompt(props: {
	text: string;
	timestamp?: unknown;
	expanded: boolean;
	onToggle: () => void;
}) {
	const tap = useTap(props.onToggle, { stopPropagation: true });
	const hover = useHover(tap.onMouseOut);
	return (
		<box
			border={["left"]}
			borderColor={uiColors.accent}
			backgroundColor={hover.hovered() ? uiColors.bgHover : uiColors.bgMantle}
			paddingBottom={1}
			paddingLeft={2}
			paddingRight={1}
			flexShrink={0}
			{...tap}
			{...hover}
		>
			<box flexDirection="row" justifyContent="flex-end" height={1}>
				<text fg={uiColors.textMuted}>{props.expanded ? "▾ " : "▸ "}</text>
				<Stamp timestamp={props.timestamp} />
			</box>
			<box
				maxHeight={props.expanded ? props.text.length + 1 : 5}
				overflow="hidden"
			>
				<text fg={uiColors.textPrimary} wrapMode="word">
					{props.text}
				</text>
			</box>
		</box>
	);
}
