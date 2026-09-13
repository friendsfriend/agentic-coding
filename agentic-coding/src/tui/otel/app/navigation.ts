import { createSignal } from "solid-js";
import { createModalHost, restoreFocus } from "../../shared/modalStack";

export type View = "selection" | "detail" | "span";
export type Modal = "filter" | "sort" | "theme" | "help" | "environment";

export function createNavigation() {
	const [views, setViews] = createSignal<View[]>(["selection"]);
	// One authoritative modal stack with instance identity (compose-unified-
	// feature-shell task 3.1): the top instance owns overlay input and closing
	// it reveals the previous overlay.
	const modals = createModalHost<Modal>();
	return {
		views,
		modalStack: modals,
		view: () => {
			const current = views().at(-1);
			if (current === undefined)
				throw new Error("navigation stack must never be empty");
			return current;
		},
		modal: () => modals.top()?.kind ?? "none",
		modalInstance: () => modals.top(),
		modalOwnsInput: () => modals.ownsInput(),
		pushView: (view: View) =>
			setViews((stack) => (stack.at(-1) === view ? stack : [...stack, view])),
		popView: () =>
			setViews((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack)),
		pushModal: (modal: Modal, restoreFocusTo?: string) =>
			modals.push({ kind: modal, restoreFocusTo }),
		popModal: () => {
			const closing = modals.top();
			modals.pop();
			restoreFocus(closing?.restoreFocusTo);
		},
		esc: () => {
			if (modals.ownsInput()) {
				const closing = modals.top();
				modals.pop();
				restoreFocus(closing?.restoreFocusTo);
				return true;
			}
			if (views().length > 1) {
				setViews((stack) => stack.slice(0, -1));
				return true;
			}
			return false;
		},
	};
}
