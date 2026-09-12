/** @jsxImportSource @opentui/solid */

import { Show } from "solid-js";
import { uiColors } from "../colors";
import { GenericModal } from "./GenericModal";
import { formatHelpText } from "./HelpText";

export interface CommentModalProps {
	text: string;
	submitting: boolean;
	error: string;
	onInput: (text: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
}

export function CommentModal(props: CommentModalProps) {
	return (
		<GenericModal
			title="Add Comment"
			helpText={formatHelpText([
				{ key: "Enter", action: "New line" },
				{ key: "Ctrl+Enter", action: "Submit" },
				{ key: "Esc", action: "Cancel" },
			])}
			widthPercent={0.6}
			heightPercent={0.5}
		>
			<box
				style={{
					width: "100%",
					flexDirection: "column",
					flexGrow: 1,
				}}
			>
				<text fg={uiColors.textMuted}>
					Comment body (Enter for newline, Ctrl+Enter to submit):
				</text>
				<box
					backgroundColor={uiColors.bgMantle}
					style={{
						width: "100%",
						flexGrow: 1,
						marginTop: 1,
						paddingLeft: 1,
						paddingRight: 1,
						flexDirection: "column",
					}}
				>
					<text fg={uiColors.textPrimary}>
						{String(props.text || "Type your comment...")}
						{props.submitting ? "" : "█"}
					</text>
				</box>
				<Show when={!!props.error}>
					<text fg={uiColors.error}>{props.error}</text>
				</Show>
			</box>
		</GenericModal>
	);
}
