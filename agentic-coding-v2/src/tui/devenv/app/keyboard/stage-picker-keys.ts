// Keys of the stage picker (`open-stage-from-environments`).
//
// The dialog is modal: while it is open every key it binds is its own. `/` starts
// filtering, Escape clears the filter before it closes the dialog, `j`/`k` (and
// the arrows) move, Enter selects — the stage first, then its application. The
// behaviour itself lives in the stage actions, so this module only maps keys.
import { isDownKey, isEnterKey, isUpKey } from "./nav-keys.ts";
import type {
	KeyboardActions,
	KeyboardEvent,
	KeyboardStores,
} from "./types.ts";

const isEscape = (event: KeyboardEvent): boolean =>
	event.name === "escape" ||
	event.name === "Escape" ||
	event.name === "esc" ||
	event.sequence === "\x1b" ||
	event.raw === "\x1b";

const isBackspace = (event: KeyboardEvent): boolean =>
	event.name === "backspace" ||
	event.name === "Backspace" ||
	event.name === "delete" ||
	event.name === "Delete";

/** The character a key event types, when it types exactly one. */
function typedChar(event: KeyboardEvent): string | undefined {
	if (event.ctrl || event.meta || event.super) return undefined;
	const name = event.name ?? event.sequence ?? "";
	return name.length === 1 ? name : undefined;
}

/**
 * Handles the stage picker's keys. False when the picker is not open, so the
 * dialog chain continues.
 */
export function handleStagePickerKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
): boolean {
	const { uiStore } = stores;
	const stageActions = actions.stageActions;
	if (!uiStore.showStagePicker()) return false;

	if (isEscape(event)) {
		// A filter is the inner state: the first Escape clears it, the second
		// leaves the dialog.
		if (
			uiStore.stagePickerFilterActive() ||
			uiStore.stagePickerQuery() !== ""
		) {
			stageActions.clearFilter();
			return true;
		}
		stageActions.close();
		return true;
	}
	if (isDownKey(event)) {
		stageActions.move(1);
		return true;
	}
	if (isUpKey(event)) {
		stageActions.move(-1);
		return true;
	}
	if (isEnterKey(event)) {
		void stageActions.confirm();
		return true;
	}
	if (event.name === "/" && !uiStore.stagePickerFilterActive()) {
		stageActions.activateFilter();
		return true;
	}
	if (uiStore.stagePickerFilterActive()) {
		if (isBackspace(event)) {
			stageActions.setFilter(uiStore.stagePickerQuery().slice(0, -1));
			return true;
		}
		const typed = typedChar(event);
		if (typed) stageActions.setFilter(uiStore.stagePickerQuery() + typed);
		return true;
	}
	return true;
}
