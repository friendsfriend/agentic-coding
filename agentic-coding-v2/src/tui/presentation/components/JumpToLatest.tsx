/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import { uiColors } from "../theme/colors.ts";
import { useHover } from "./mouse/useHover.ts";
import { useTap } from "./mouse/useTap.ts";

/** Original one-row latest affordance. Its callback is local viewport intent,
 * not a request to obtain newer history or activate a native conversation. */
export function JumpToLatest(props: {
	visible: boolean;
	enabled: boolean;
	onJump: () => void;
}) {
	const hover = useHover();
	return (
		<box
			width="100%"
			height={1}
			flexShrink={0}
			flexDirection="row"
			justifyContent="flex-end"
		>
			<Show when={props.visible}>
				<box
					paddingLeft={1}
					{...hover}
					{...useTap(
						() => {
							if (props.enabled) props.onJump();
						},
						{ stopPropagation: true },
					)}
				>
					<text
						fg={
							props.enabled && hover.hovered()
								? uiColors.primary
								: uiColors.textMuted
						}
					>
						Jump to latest ↓
					</text>
				</box>
			</Show>
		</box>
	);
}
