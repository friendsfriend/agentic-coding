import type { DialogDismissKind } from "./dismissPolicy.ts";
import { useKeyDispatch } from "./useKeybindChips.ts";

export interface ModalBackdropProps {
	onBackdropClick: () => void;
	dismissKind: DialogDismissKind;
	dismissBlocked: () => boolean;
}

/**
 * The backdrop half of a dialog, ready to spread into `GenericModal`.
 *
 * A read-only dialog dismisses on a backdrop tap by dispatching the key it
 * already binds (`Esc`), so the tap can only ever do what the key does — the
 * modal stack still decides which layer handles it — and no surface needs a
 * second close path. `dismissKind` names the dialog so the shared policy
 * (design D5) refuses the tap for one that holds a draft, a secret, a running
 * operation or an irreversible action.
 */
export function useModalBackdrop(options: {
	kind: DialogDismissKind;
	/** Explicit dismissal, when the surface has a close callback of its own. */
	dismiss?: () => void;
	/** True while a dismissal would discard something. */
	blocked?: () => boolean;
}): ModalBackdropProps {
	const dispatch = useKeyDispatch();
	return {
		dismissKind: options.kind,
		onBackdropClick: () => {
			if (options.dismiss) options.dismiss();
			else dispatch("Esc");
		},
		dismissBlocked: () => options.blocked?.() ?? false,
	};
}
