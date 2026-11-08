/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { createEffect, onCleanup, Show } from "solid-js";
import type { LocalNotice } from "../../ui/notifications.ts";
import { uiColors } from "../theme/colors.ts";
import { useHover } from "./mouse/useHover.ts";
import type { RowGestureState } from "./mouse/useRowMouse.ts";
import { useTap } from "./mouse/useTap.ts";

/** Original corner-toast geometry/tones. Required diagnostics live in a separate
 * read-only dialog, not a disappearing toast. Selection drags do not dismiss. */
export function NotificationOverlay(props: {
	active: () => LocalNotice | undefined;
	dismiss: (item: LocalNotice) => void;
	interactive: () => boolean;
}) {
	return (
		<Show when={props.active()} keyed>
			{(item) => {
				let disposed = false;
				const gesture: RowGestureState = {};
				const forget = () => {
					gesture.down = undefined;
					gesture.lastTap = undefined;
				};
				onCleanup(() => {
					disposed = true;
					forget();
				});
				const enabled = () =>
					!disposed && props.active() === item && props.interactive();
				const tap = useTap(
					() => {
						if (enabled()) props.dismiss(item);
					},
					{ enabled, gesture },
				);
				createEffect(() => {
					enabled();
					forget();
				});
				const mouse = {
					...tap,
					onMouseDown: (event: Parameters<typeof tap.onMouseDown>[0]) => {
						forget();
						if (enabled()) tap.onMouseDown(event);
					},
					onMouseUp: (event: Parameters<typeof tap.onMouseUp>[0]) => {
						if (enabled()) tap.onMouseUp(event);
						else forget();
					},
				};
				const hover = useHover(tap.onMouseOut);
				const bg =
					item.type === "success"
						? uiColors.success
						: item.type === "warning"
							? uiColors.warning
							: item.type === "error"
								? uiColors.error
								: uiColors.info;
				const icon =
					item.type === "success"
						? "✓ "
						: item.type === "warning"
							? "! "
							: item.type === "error"
								? "✗ "
								: "ℹ ";
				const points = Array.from(item.message.replace(/\s+/g, " "));
				const summary =
					points.slice(0, 120).join("") + (points.length > 120 ? "…" : "");
				return (
					<box
						position="absolute"
						right={2}
						bottom={1}
						paddingLeft={2}
						paddingRight={2}
						backgroundColor={bg}
						{...mouse}
						{...hover}
					>
						<text
							fg={uiColors.bgBase}
							attributes={
								hover.hovered() && enabled()
									? TextAttributes.BOLD | TextAttributes.UNDERLINE
									: TextAttributes.BOLD
							}
						>
							{icon}
							{summary}
						</text>
					</box>
				);
			}}
		</Show>
	);
}
