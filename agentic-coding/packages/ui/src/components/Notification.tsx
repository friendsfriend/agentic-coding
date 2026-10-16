/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { uiColors } from "../theme/colors";
import { useTap } from "./mouse/useTap.ts";

export type SharedNotification = {
	message: string;
	type: "info" | "success" | "warning" | "error";
};

/**
 * NotificationOverlay - shared corner toast. The active notification is
 * injected as a reactive accessor so each surface keeps its own notification
 * store while the overlay rendering stays single-sourced.
 */
export function NotificationOverlay(props: {
	active: () => SharedNotification | undefined;
	/**
	 * Pointer: a tap dismisses the toast through the surface's own dismiss path
	 * (the same clear its auto-expiry runs, design D2/`tui-mouse-interaction`).
	 * A toast that carries a required developer action is not rendered here.
	 */
	onDismiss?: () => void;
}) {
	// A tap dismisses: the shared rule drops drags and non-primary buttons, so a
	// text selection over the toast never dismisses it.
	const tap = useTap(() => props.onDismiss?.());
	return (
		<Show when={props.active()} keyed>
			{(item) => {
				const n = item;
				const bg =
					n.type === "success"
						? uiColors.success
						: n.type === "warning"
							? uiColors.warning
							: n.type === "error"
								? uiColors.error
								: uiColors.info;
				const icon =
					n.type === "success"
						? "✓ "
						: n.type === "warning"
							? "! "
							: n.type === "error"
								? "✗ "
								: "ℹ ";
				return (
					<box
						position="absolute"
						right={2}
						bottom={1}
						paddingLeft={2}
						paddingRight={2}
						backgroundColor={bg}
						{...tap}
					>
						<text fg={uiColors.bgBase} attributes={TextAttributes.BOLD}>
							{icon}
							{n.message}
						</text>
					</box>
				);
			}}
		</Show>
	);
}
