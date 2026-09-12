import { isDownKey, isUpKey } from "./nav-keys";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types";
/**
 * Handles keyboard events for the Worktree Manager modal.
 * Consumes all events while the modal is open.
 *
 * Keys:
 *   j / ArrowDown  → move cursor down
 *   k / ArrowUp    → move cursor up
 *   n              → open branch selector for new worktree
 *   d              → delete selected worktree (guard via removeWorktreeFromManager)
 *   Escape / q     → close modal
 */
export async function handleWorktreeManagerKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
	_ctx: KeyboardContext,
): Promise<boolean> {
	const { uiStore } = stores;
	const { gitActions } = actions;

	if (!uiStore.showWorktreeManagerModal()) return false;

	// If the branch selector is open (e.g. for new worktree creation), yield to
	// the branch selector handler — do not consume events here.
	if (uiStore.showBranchSelector()) return false;

	// Switch to selected worktree
	if (
		event.name === "return" ||
		event.name === "Return" ||
		event.name === "enter" ||
		event.name === "Enter" ||
		event.sequence === "\r"
	) {
		await gitActions.switchWorktreeFromManager();
		return true;
	}

	// Move cursor down
	if (isDownKey(event)) {
		const max = Math.max(0, uiStore.worktreeManagerWorktrees().length - 1);
		uiStore.setWorktreeManagerSelectedIndex((prev) =>
			Math.min(Math.max(prev, 0) + 1, max),
		);
		return true;
	}

	// Move cursor up
	if (isUpKey(event)) {
		uiStore.setWorktreeManagerSelectedIndex((prev) => Math.max(prev - 1, 0));
		return true;
	}

	// New worktree — open branch selector in worktree-create mode
	if (event.name === "n" || event.sequence === "n") {
		const appId = uiStore.worktreeManagerAppId();
		if (appId) {
			void gitActions.openBranchSelectorForNewWorktree(appId);
		}
		return true;
	}

	// Delete selected worktree
	if (event.name === "d" || event.sequence === "d") {
		await gitActions.removeWorktreeFromManager();
		return true;
	}

	// Close modal
	if (
		event.name === "escape" ||
		event.name === "Escape" ||
		event.name === "esc" ||
		event.sequence === "\x1b" ||
		event.raw === "\x1b" ||
		event.name === "q" ||
		event.sequence === "q"
	) {
		uiStore.setShowWorktreeManagerModal(false);
		uiStore.setWorktreeManagerAppId(null);
		uiStore.setWorktreeManagerWorktrees([]);
		uiStore.setWorktreeManagerSelectedIndex(0);
		return true;
	}

	// Consume all other keys while modal is open
	return true;
}
