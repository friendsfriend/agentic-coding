import { isDownKey, isUpKey } from "./nav-keys";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types";

/**
 * Handles keyboard events for the issue timeline view.
 * Simpler than CR discussions — no reply/resolve/diff features.
 */
export async function handleIssueTimelineKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	_actions: KeyboardActions,
	_ctx: KeyboardContext,
): Promise<boolean> {
	const { appStore, issueStore } = stores;

	if (appStore.viewMode() !== "issueTimeline") return false;

	const comments = issueStore.issueComments();
	const total = comments.length;

	// ESC/q to go back to issue detail
	if (
		event.name === "escape" ||
		event.name === "Escape" ||
		event.name === "esc" ||
		event.name === "q"
	) {
		appStore.popView();
		issueStore.setSelectedTimelineIndex(0);
		return true;
	}

	if (total === 0) return true;

	// j/↓ to move down
	if (isDownKey(event)) {
		issueStore.setSelectedTimelineIndex((prev) =>
			Math.min(prev + 1, total - 1),
		);
		return true;
	}

	// k/↑ to move up
	if (isUpKey(event)) {
		issueStore.setSelectedTimelineIndex((prev) => Math.max(prev - 1, 0));
		return true;
	}

	// g to go to top
	if (event.name === "g" && !event.shift) {
		issueStore.setSelectedTimelineIndex(0);
		return true;
	}

	// G to go to bottom
	if (event.name === "G" || (event.name === "g" && event.shift)) {
		issueStore.setSelectedTimelineIndex(Math.max(0, total - 1));
		return true;
	}

	return true;
}
