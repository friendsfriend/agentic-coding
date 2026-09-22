/** Developer-dialogue route (establish-opencode-boundaries, task 6.1).
 *
 * The blocking human conversations: the developer question form, the credential
 * prompt and the review-finishing progress, plus the dialog-local `?` help
 * overlay. Props-in: the dialogue state, the pending question group and the
 * credential request come from the routes that own them; answering is a
 * callback. */
import type { ScrollBoxRenderable } from "@opentui/core";
import { MarkdownModal, ModalHelpOverlay, ProgressModal } from "@ui";
import { createEffect, Show } from "solid-js";
import type { DeveloperDialogueRecord } from "../../../contracts/workflow.ts";
import type { DialogueState } from "../state.ts";
import { CredentialsModal } from "../ui/CredentialsModal.tsx";
import { DeveloperQuestionModal } from "../ui/DeveloperQuestionModal.tsx";

export interface DialogueRouteProps {
	readonly dialogue: DialogueState;
	/** Whether the question dialog owns an entry in the shell modal host. */
	readonly open: boolean;
	/** The question group awaiting an answer, if any. */
	readonly pendingGroup: readonly DeveloperDialogueRecord[];
	/** Credential prompt from the backend, if one is pending. */
	readonly credential?: { readonly prompt: string; readonly mask: boolean };
	readonly credentialInput: string;
	/** The shell's modal host top kind: a prompt only owns keys when on top. */
	readonly modalTop: () => string | undefined;
	readonly finishing: boolean;
	readonly finishingMessage: string;
	readonly onCustomTextChange: (text: string) => void;
}

export function DialogueRoute(props: DialogueRouteProps) {
	const dialogue = () => props.dialogue;
	let detailScroll: ScrollBoxRenderable | undefined;
	createEffect(() => detailScroll?.scrollTo(dialogue().detailOffset()));
	return (
		<>
			<Show when={props.open && props.pendingGroup.length > 0}>
				{(_group) => (
					<DeveloperQuestionModal
						questions={[...props.pendingGroup]}
						activeIndex={dialogue().tab()}
						promptOffset={dialogue().promptOffset()}
						selected={dialogue().selection()}
						custom={dialogue().custom()}
						customText={dialogue().customText()}
						responseState={props.pendingGroup.map((item) =>
							dialogue().drafts()[item.id]?.value.trim()
								? "answered"
								: "unanswered",
						)}
						onCustomTextChange={props.onCustomTextChange}
					/>
				)}
			</Show>
			<Show when={props.open && dialogue().optionDetail()}>
				{(detail) => (
					<MarkdownModal
						title={detail().title}
						content={detail().content}
						zIndex={25}
						onScrollBoxReady={(scrollbox) => {
							detailScroll = scrollbox;
						}}
					/>
				)}
			</Show>
			<Show when={props.credential}>
				{(request) => (
					<Show when={props.modalTop() === "credentials"}>
						<CredentialsModal
							prompt={request().prompt}
							mask={request().mask}
							value={props.credentialInput}
						/>
					</Show>
				)}
			</Show>
			<Show when={props.finishing}>
				{/* Stacks above the still-open review popup; cleared in the finish
				    handlers' existing finally cleanup. */}
				<ProgressModal
					title="Finishing review"
					message={props.finishingMessage}
				/>
			</Show>
			{/* The open dialog's own `?` help, above every dialog (question z20,
			    credentials z10). */}
			<ModalHelpOverlay zIndex={30} />
		</>
	);
}
