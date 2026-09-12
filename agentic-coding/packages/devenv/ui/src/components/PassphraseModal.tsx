/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { Show } from "solid-js";
import { uiColors } from "../colors";
import { GenericModal } from "./GenericModal";
import { formatHelpText } from "./HelpText";
import { RunningText } from "./RunningText";

export interface PassphraseModalProps {
	/** Path to the identity file that needs unlocking */
	identityFile: string;
	/** The passphrase typed so far (will be displayed as asterisks) */
	passphraseText: string;
	/** Error message if the last attempt failed, null otherwise */
	error: string | null;
	runningTextEnabled?: boolean;
	runningTextOffset?: number;
}

export function PassphraseModal(props: PassphraseModalProps) {
	const dimensions = useTerminalDimensions();
	const masked = () => "*".repeat(props.passphraseText.length);
	const hasInput = () => props.passphraseText.length > 0;

	const pathWidth = () => Math.max(1, Math.floor(dimensions().width * 0.4) - 8);

	const helpText = formatHelpText([
		{ key: "Enter", action: "Unlock" },
		{ key: "Esc", action: "Cancel" },
	]);

	return (
		<GenericModal
			title="SSH Key Passphrase"
			helpText={helpText}
			widthPercent={0.4}
			heightPercent={0.22}
		>
			{/* Key file label */}
			<box
				style={{
					width: "100%",
					height: 1,
					flexDirection: "row",
					flexShrink: 0,
					marginBottom: 1,
				}}
			>
				<text fg={uiColors.textMuted}>{"Key: "}</text>
				<RunningText
					text={props.identityFile}
					width={pathWidth()}
					fg={uiColors.textSecondary}
					enabled={props.runningTextEnabled}
					active
					offset={props.runningTextOffset}
				/>
			</box>

			{/* Passphrase input row */}
			<box
				style={{
					width: "100%",
					height: 1,
					flexDirection: "row",
					flexShrink: 0,
					marginBottom: 1,
				}}
			>
				<text fg={uiColors.textMuted}>{"Passphrase: "}</text>
				<text
					fg={hasInput() ? uiColors.textPrimary : uiColors.textMuted}
					attributes={hasInput() ? TextAttributes.BOLD : undefined}
				>
					{hasInput() ? masked() : "enter passphrase..."}
				</text>
				{hasInput() && <text fg={uiColors.primary}>{"█"}</text>}
			</box>

			{/* Error message row */}
			<Show when={props.error}>
				<box
					style={{
						width: "100%",
						height: 1,
						flexDirection: "row",
						flexShrink: 0,
					}}
				>
					<text fg={uiColors.error}>{props.error ?? ""}</text>
				</box>
			</Show>
		</GenericModal>
	);
}
