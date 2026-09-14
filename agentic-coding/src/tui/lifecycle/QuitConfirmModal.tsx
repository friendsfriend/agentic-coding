/** @jsxImportSource @opentui/solid */
// Interactive quit guard: shown when the user quits while owned workflow work
// (drains/actions) is still running. Confirming cancels that work through the
// domain cancellation boundary and then runs the same shutdown sequence;
// declining returns to the shell. Noninteractive signals never render this
// (see `requestShutdown({ signal: true })`).
import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { quitConfirmation } from "../lifecycle";
import { uiColors } from "../shared/colors";
import { GenericModal } from "../shared/GenericModal";

export function QuitConfirmModal() {
	return (
		<Show when={quitConfirmation()}>
			{(description) => (
				<GenericModal
					title="Quit with work in progress?"
					widthPercent={0.6}
					heightLines={9}
					zIndex={20}
					help={[
						{ key: "y", action: "Cancel work and quit" },
						{ key: "n", action: "Stay" },
					]}
					helpSections={false}
				>
					<box flexDirection="column" gap={1}>
						<text fg={uiColors.textPrimary}>{description()}</text>
						<text fg={uiColors.textMuted} attributes={TextAttributes.DIM}>
							Quitting stops the owned application stack. Durable workspaces,
							containers and tmux sessions are left untouched.
						</text>
					</box>
				</GenericModal>
			)}
		</Show>
	);
}
