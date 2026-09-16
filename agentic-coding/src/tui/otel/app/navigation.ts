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
		/** Close the top overlay. Returns false when no overlay owns input, so
		 * the caller can fall through to navigation. */
		esc: () => {
			if (!modals.ownsInput()) return false;
			const closing = modals.top();
			modals.pop();
			restoreFocus(closing?.restoreFocusTo);
			return true;
		},
	};
}
