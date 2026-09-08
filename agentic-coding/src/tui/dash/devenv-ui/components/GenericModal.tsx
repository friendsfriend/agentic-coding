/** @jsxImportSource @opentui/solid */
// Shared portaled modal framing (src/tui/shared/GenericModal.tsx) with the
// devenv surface's legacy look pinned: translucent dialog background and
// dialog clicks never fall through to the backdrop close handler.

import type { GenericModalProps } from "../../../shared/GenericModal";
import { GenericModal as SharedGenericModal } from "../../../shared/GenericModal";

export type { GenericModalProps } from "../../../shared/GenericModal";
export type { HelpEntry } from "../../../shared/HelpText";

export function GenericModal(props: GenericModalProps) {
	return (
		<SharedGenericModal
			{...props}
			dialogAlpha={props.dialogAlpha ?? 0.92}
			stopDialogClick
		/>
	);
}
