/** @jsxImportSource @opentui/solid */
// Shared portaled modal framing (src/tui/shared/GenericModal.tsx) with the
// environment surface's legacy look pinned: translucent dialog background and
// dialog clicks never fall through to the backdrop close handler. The
// environment shell has no modal-help overlay/`handleModalHelpKey`, so modal
// `? help` stays off unless a caller explicitly wires it: advertising it would
// promise a key the host cannot route.

import type { GenericModalProps } from "@ui";
import { GenericModal as SharedGenericModal } from "@ui";

export type {
	GenericModalProps,
	HelpEntry,
	Keybind,
	KeybindSection,
} from "@ui";

export function GenericModal(props: GenericModalProps) {
	return (
		<SharedGenericModal
			{...props}
			dialogAlpha={props.dialogAlpha ?? 0.92}
			helpSections={props.helpSections ?? false}
			stopDialogClick
		/>
	);
}
