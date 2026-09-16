import { createModalHost, restoreFocus } from "../../shared/modalStack";

/**
 * Shell overlay authority (replace-nested-tabs-with-page-navigation, task 2.3).
 * Page views and history moved to the route authority in `../../shared/routes`;
 * this module is now only the authoritative modal stack: the top instance owns
 * overlay input and closing it reveals the previous overlay.
 */
export type Modal =
	| "filter"
	| "sort"
	| "theme"
	| "help"
	| "environment"
	| "locations"
	| "new-workflow";

/**
 * Overlay kinds the shell handler itself owns. `environment` is deliberately
 * absent: the embedded feature renders that dialog and reports its own close.
 */
const SHELL_OWNED_OVERLAY_NAMES: readonly Modal[] = [
	"locations",
	"help",
	"theme",
	"filter",
	"sort",
	// Contextual workflow creation: the shell owns the form and its start
	// boundary, so its keys are routed through the one shell dispatcher.
	"new-workflow",
];

/** Whether the current overlay kind is one the shell handler owns. */
export function isShellOwnedOverlay(kind: string): kind is Modal {
	return (SHELL_OWNED_OVERLAY_NAMES as readonly string[]).includes(kind);
}

export function createNavigation() {
	const modals = createModalHost<Modal>();
	return {
		modalStack: modals,
		modal: () => modals.top()?.kind ?? "none",
		modalInstance: () => modals.top(),
		modalOwnsInput: () => modals.ownsInput(),
		pushModal: (modal: Modal, restoreFocusTo?: string) =>
			modals.push({ kind: modal, restoreFocusTo }),
		popModal: () => {
			const closing = modals.top();
			modals.pop();
			restoreFocus(closing?.restoreFocusTo);
		},
		/**
		 * Close the top shell-owned overlay. Returns false when no shell overlay owns
		 * input, so the caller can fall through to navigation. A feature-owned entry
		 * (the mirrored `environment` dialog) is never popped here: its own report
		 * closes it, and popping the mirror would desync the two.
		 */
		esc: () => {
			const top = modals.top();
			if (!modals.ownsInput() || !top) return false;
			if (!isShellOwnedOverlay(top.kind)) return false;
			modals.pop();
			restoreFocus(top.restoreFocusTo);
			return true;
		},
	};
}
