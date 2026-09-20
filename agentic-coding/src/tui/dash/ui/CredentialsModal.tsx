/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { GenericModal, uiColors } from "@ui";
import { createSignal } from "solid-js";
import { type CredentialPrompt, maskingFor } from "../../data/agents.ts";

export interface CredentialPromptRequest {
	prompt: string;
	mask: boolean;
}

interface PendingCredentialRequest extends CredentialPromptRequest {
	id: number;
	resolve: (answer: string) => void;
}

// Module-level pending-request store: the in-process effect runner (engine.ts)
// resolves a credential prompt by setting this signal, and the dashboard App
// renders the popup from it. A fresh request supersedes any pending one.
const [pending, setPending] = createSignal<
	PendingCredentialRequest | undefined
>(undefined);
let nextRequestId = 0;

export function pendingCredentialRequest():
	| PendingCredentialRequest
	| undefined {
	return pending();
}

export function credentialPromptBridge(): CredentialPrompt {
	return (prompt: string, signal?: AbortSignal) =>
		new Promise<string>((resolve) => {
			if (signal?.aborted) {
				resolve("");
				return;
			}
			const previous = pending();
			if (previous) previous.resolve("");
			let settled = false;
			const request: PendingCredentialRequest = {
				id: ++nextRequestId,
				prompt,
				mask: maskingFor(prompt),
				resolve: (answer) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", abort);
					// A stale modal may still hold this callback; never clear a newer
					// credential request (SEC-001/CONCURRENCY-002).
					if (pending() === request) setPending(undefined);
					resolve(answer);
				},
			};
			const abort = () => request.resolve("");
			signal?.addEventListener("abort", abort, { once: true });
			setPending(request);
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
			zIndex={30}
			help={[
				{ key: "Enter", action: "Submit" },
				{ key: "Esc", action: "Cancel" },
			]}
			helpSections={false}
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
