/** @jsxImportSource @opentui/solid */
// Dashboard agent session view (add-pi-durable-runtime,
// dashboard-agent-session-view): a live, writable view of one `pi-durable`
// agent run, opened from the Agents panel. Status/transcript lines are owned
// by the route (a live `HostClient.watch()` subscription); this component
// owns only the compose-input UI. No keymap layer is registered for this
// modal: the focused `<input>` captures its own keys directly, the same
// pattern `NewWorkflowModal` uses.
//
// Close and abort are both slash commands submitted through the same input
// (not key bindings): a focused OpenTUI `<input>`/`<textarea>` never
// forwards Escape to `onKeyDown` (confirmed empirically while building this
// view — it reaches `onKeyDown` for ordinary characters and Tab, never for
// Escape), so an "Esc closes" binding would silently do nothing. A slash
// command needs no key binding at all and is already proven to work through
// the same `onSubmit` path a message uses.
import type { InputRenderable } from "@opentui/core";
import { GenericModal, uiColors } from "@ui";
import { For } from "solid-js";

export interface AgentSessionModalProps {
	readonly role: string;
	readonly statusLines: readonly string[];
	readonly draft: string;
	readonly onDraftChange: (value: string) => void;
	readonly onSubmit: (text: string) => void;
	readonly onAbort: () => void;
	readonly onClose: () => void;
}

/** Typing one of these exact messages, instead of an ordinary one, performs
 * the named action. See the module comment for why these are slash commands
 * rather than key bindings. */
export const ABORT_COMMAND = "/abort";
export const CLOSE_COMMAND = "/close";

/** A session line that reports a provider/tool failure, rendered in the theme's
 * error color so a failed generation cannot be mistaken for ordinary output. */
function isErrorLine(line: string): boolean {
	return line.startsWith("Error:") || line.includes("⚠");
}

export function AgentSessionModal(props: AgentSessionModalProps) {
	let inputRef: InputRenderable | undefined;
	return (
		<GenericModal
			title={`Agent · ${props.role}`}
			widthPercent={0.72}
			heightPercent={0.8}
			fieldLabel="Session"
			help={[
				{ key: "Enter", action: "Send message" },
				{ key: ABORT_COMMAND, action: "Abort the run (type as the message)" },
				{ key: CLOSE_COMMAND, action: "Close this view (type as the message)" },
			]}
		>
			<box width="100%" flexDirection="column" flexGrow={1} gap={1}>
				<box
					width="100%"
					flexDirection="column"
					flexGrow={1}
					minHeight={0}
					overflow="hidden"
				>
					<For each={props.statusLines}>
						{(line) => (
							<text
								fg={isErrorLine(line) ? uiColors.error : uiColors.textSecondary}
							>
								{line}
							</text>
						)}
					</For>
				</box>
				<input
					ref={inputRef}
					focused
					value={props.draft}
					placeholder="Type a message, /abort, or /close, then press Enter…"
					onInput={(value: string) => props.onDraftChange(value)}
					onSubmit={() => {
						const text = (inputRef?.value ?? props.draft).trim();
						if (!text) return;
						if (text === CLOSE_COMMAND) {
							props.onClose();
							return;
						}
						if (text === ABORT_COMMAND) props.onAbort();
						else props.onSubmit(text);
						props.onDraftChange("");
					}}
					focusedBackgroundColor={uiColors.bgBase}
					focusedTextColor={uiColors.textPrimary}
				/>
			</box>
		</GenericModal>
	);
}
