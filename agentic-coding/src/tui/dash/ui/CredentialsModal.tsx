/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { createSignal } from "solid-js";
import {
	type CredentialPrompt,
	maskingFor,
} from "../../../workflow/credentials.ts";
import { uiColors } from "./colors";
import { GenericModal } from "./GenericModal";

export interface CredentialPromptRequest {
	prompt: string;
	mask: boolean;
}

interface PendingCredentialRequest extends CredentialPromptRequest {
	resolve: (answer: string) => void;
}

// Module-level pending-request store: the in-process effect runner (engine.ts)
// resolves a credential prompt by setting this signal, and the dashboard App
// renders the popup from it. A fresh request supersedes any pending one.
const [pending, setPending] = createSignal<
	PendingCredentialRequest | undefined
>(undefined);

export function pendingCredentialRequest():
	| PendingCredentialRequest
	| undefined {
	return pending();
}

export function credentialPromptBridge(): CredentialPrompt {
	return (prompt: string) =>
		new Promise<string>((resolve) => {
			const previous = pending();
			if (previous) previous.resolve("");
			setPending({
				prompt,
				mask: maskingFor(prompt),
				resolve: (answer) => {
					setPending(undefined);
					resolve(answer);
				},
			});
		});
}

export function CredentialsModal(props: {
	prompt: string;
	mask: boolean;
	value: string;
}) {
	return (
		<GenericModal
			title="SSH credential required"
			fieldLabel={props.prompt}
			widthPercent={0.6}
			heightPercent={0.35}
			zIndex={10}
			help={[
				{ key: "Enter", action: "Submit" },
				{ key: "Esc", action: "Cancel" },
			]}
		>
			<box
				width="100%"
				flexGrow={1}
				flexDirection="column"
				paddingTop={1}
				gap={1}
			>
				<text fg={uiColors.textMuted}>
					{props.mask ? "Passphrase (masked)" : "Answer"}
				</text>
				<box
					width="100%"
					height={1}
					backgroundColor={uiColors.bgBase}
					paddingLeft={1}
					flexDirection="row"
				>
					<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
						{props.mask ? "*".repeat(props.value.length) : props.value}
					</text>
					<text fg={uiColors.primary}>█</text>
				</box>
			</box>
		</GenericModal>
	);
}
