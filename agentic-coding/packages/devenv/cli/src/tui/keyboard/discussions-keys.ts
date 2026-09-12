import { getLogger } from "@devenv/core";
import { computeInitialSplitView } from "./diff-modal-utils";
import { isDownKey, isUpKey } from "./nav-keys";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types";
/**
 * Handles keyboard events for the Discussions view:
 * - Reply mode: ESC to cancel, Ctrl+Enter to submit, text input
 * - ESC to go back to CR detail
 * - Shift+D to open diff for selected discussion's file
 * - Shift+C to switch to changed files view
 * - c to toggle comments-only filter
 * - r to reply, x to resolve/unresolve
 * - j/k/g/G for navigation
 */
export async function handleDiscussionsKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
	ctx: KeyboardContext,
): Promise<boolean> {
	const { appStore, changeRequestStore } = stores;
	const { crActions } = actions;
	const { showError } = ctx;

	if (appStore.viewMode() !== "discussionsView") return false;

	const discussions = changeRequestStore.crDiscussions();

	// CHECK REPLY MODE FIRST (takes precedence over navigation)
	if (changeRequestStore.replyMode()) {
		// ESC to cancel reply
		if (
			event.name === "escape" ||
			event.name === "Escape" ||
			event.name === "esc"
		) {
			changeRequestStore.setReplyMode(null);
			changeRequestStore.setReplyText("");
			getLogger().write("INFO", "Reply mode cancelled in discussions view");
			return true;
		}

		// Ctrl+Enter to submit reply
		if (
			event.ctrl &&
			(event.name === "return" ||
				event.name === "enter" ||
				event.name === "Return" ||
				event.name === "Enter")
		) {
			const discussionId = changeRequestStore.replyMode();
			const text = changeRequestStore.replyText().trim();

			if (!text) {
				showError("Empty Reply", "Please enter a reply");
				return true;
			}

			if (!discussionId) return true;
			crActions.replyToDiscussion(discussionId, text);
			changeRequestStore.setReplyMode(null);
			changeRequestStore.setReplyText("");
			return true;
		}

		// Backspace to delete last character
		if (event.name === "backspace" || event.name === "Backspace") {
			changeRequestStore.setReplyText(
				changeRequestStore.replyText().slice(0, -1),
			);
			return true;
		}

		// Regular text input (printable characters)
		if (event.name && event.name.length === 1 && !event.ctrl && !event.meta) {
			changeRequestStore.setReplyText(
				changeRequestStore.replyText() + event.name,
			);
			return true;
		}

		// Space key
		if (event.name === "space" || event.name === " ") {
			changeRequestStore.setReplyText(`${changeRequestStore.replyText()} `);
			return true;
		}

		return true; // Block all other keys when reply mode is active
	}

	// IMPORTANT: Sort and filter discussions the same way DiscussionsView does
	const filteredDiscussions = changeRequestStore.discussionsShowOnlyComments()
		? discussions.filter((d) => !(d.notes.length > 0 && d.notes[0].system))
		: discussions;
	const sortedDiscussions = [...filteredDiscussions].sort((a, b) => {
		const aLatest = a.notes.reduce((latest, note) => {
			const noteTime = new Date(note.created_at).getTime();
			return noteTime > latest ? noteTime : latest;
		}, 0);
		const bLatest = b.notes.reduce((latest, note) => {
			const noteTime = new Date(note.created_at).getTime();
			return noteTime > latest ? noteTime : latest;
		}, 0);
		return bLatest - aLatest; // Newest first
	});

	const totalDiscussions = sortedDiscussions.length;

	// Debug: Log all keypresses in discussions view
	getLogger().write(
		"DEBUG",
		`[DISCUSSIONS VIEW] Key: name="${event.name}", sequence="${event.sequence}", shift=${event.shift}, ctrl=${event.ctrl}`,
	);

	// ESC to go back to CR detail
	if (
		event.name === "escape" ||
		event.name === "Escape" ||
		event.name === "esc" ||
		event.sequence === "\x1b" ||
		event.raw === "\x1b"
	) {
		appStore.popView();
		changeRequestStore.setSelectedDiscussionIndex(0);
		return true;
	}

	// Shift+D to view full diff for the selected discussion's file
	if (
		event.sequence === "D" ||
		event.name === "D" ||
		(event.name === "d" && event.shift)
	) {
		getLogger().write(
			"DEBUG",
			`[DISCUSSIONS VIEW] Shift+D detected! selectedIndex=${changeRequestStore.selectedDiscussionIndex()}, totalDiscussions=${totalDiscussions}`,
		);
		const discussion =
			sortedDiscussions[changeRequestStore.selectedDiscussionIndex()];
		if (discussion) {
			getLogger().write(
				"DEBUG",
				`[DISCUSSIONS VIEW] Discussion found: ${discussion.id}`,
			);
			getLogger().write(
				"DEBUG",
				`[DISCUSSIONS VIEW] discussion.position: ${JSON.stringify(discussion.position)}`,
			);
			getLogger().write(
				"DEBUG",
				`[DISCUSSIONS VIEW] discussion.notes.length: ${discussion.notes?.length || 0}`,
			);
			if (discussion.notes && discussion.notes.length > 0) {
				getLogger().write(
					"DEBUG",
					`[DISCUSSIONS VIEW] discussion.notes[0].position: ${JSON.stringify(discussion.notes[0].position)}`,
				);
			}

			// Get the file path from the discussion position
			const position =
				discussion.position ||
				(discussion.notes && discussion.notes.length > 0
					? discussion.notes[0].position
					: null);
			if (position) {
				const filePath = position.new_path || position.old_path;
				getLogger().write("DEBUG", `[DISCUSSIONS VIEW] File path: ${filePath}`);
				if (filePath) {
					// Find the corresponding change
					const changes = changeRequestStore.crChanges();
					getLogger().write(
						"DEBUG",
						`[DISCUSSIONS VIEW] Total changes: ${changes.length}`,
					);
					const change = changes.find(
						(c) => c.new_path === filePath || c.old_path === filePath,
					);
					if (change) {
						getLogger().write(
							"DEBUG",
							`[DISCUSSIONS VIEW] Change found! Opening diff modal...`,
						);
						changeRequestStore.setCurrentDiffFile(change);
						changeRequestStore.setDiffModalSelectedLine(0);
						changeRequestStore.setDiffModalVisualMode(false);
						changeRequestStore.setDiffModalForceSplitView(
							computeInitialSplitView(
								change.diff ?? "",
								ctx.renderer.width,
								change.new_file || change.deleted_file,
							),
						);
						changeRequestStore.setShowDiffModal(true);
						appStore.setPreviousViewMode("discussionsView"); // Remember to return to discussions view
						getLogger().write(
							"DEBUG",
							`[DISCUSSIONS VIEW] Diff modal should be open now`,
						);
					} else {
						getLogger().write(
							"DEBUG",
							`[DISCUSSIONS VIEW] No matching change found for file: ${filePath}`,
						);
						getLogger().write(
							"DEBUG",
							`[DISCUSSIONS VIEW] Available changes: ${changes.map((c) => c.new_path || c.old_path).join(", ")}`,
						);
						showError(
							"File Not Found",
							`Cannot find diff for file: ${filePath}`,
						);
					}
				}
			} else {
				getLogger().write(
					"DEBUG",
					`[DISCUSSIONS VIEW] No position found in discussion - this is a general comment, silently ignoring Shift+D`,
				);
			}
		} else {
			getLogger().write(
				"DEBUG",
				`[DISCUSSIONS VIEW] No discussion at index ${changeRequestStore.selectedDiscussionIndex()}`,
			);
		}
		return true;
	}

	// Shift+C to switch to Changed Files view
	if (
		event.sequence === "C" ||
		event.name === "C" ||
		(event.name === "c" && event.shift)
	) {
		getLogger().write(
			"DEBUG",
			`[DISCUSSIONS VIEW] Shift+C detected! Switching to changedFiles view`,
		);
		appStore.pushView("changedFiles");
		changeRequestStore.setSelectedChangedFileIndex(0);
		return true;
	}

	// c to toggle comments-only filter (hides system notes)
	if (event.name === "c" && !event.shift && !event.ctrl) {
		getLogger().write(
			"DEBUG",
			`[DISCUSSIONS VIEW] c key pressed - toggling comments filter`,
		);
		changeRequestStore.setDiscussionsShowOnlyComments((prev) => !prev);
		changeRequestStore.setSelectedDiscussionIndex(0);
		return true;
	}

	// r to reply to the selected discussion
	if (event.name === "r" && !event.shift && !event.ctrl) {
		getLogger().write("DEBUG", `[DISCUSSIONS VIEW] r key pressed for reply`);
		const discussion =
			sortedDiscussions[changeRequestStore.selectedDiscussionIndex()];
		if (discussion) {
			// Don't allow replies to system notes
			const isSystemNote =
				discussion.notes.length > 0 && discussion.notes[0].system;
			if (isSystemNote) {
				showError(
					"System Event",
					"Cannot reply to system events. Only user comments support replies.",
				);
				return true;
			}

			changeRequestStore.setReplyMode(discussion.id);
			changeRequestStore.setReplyText("");
			getLogger().write(
				"INFO",
				`Entering reply mode for discussion ${discussion.id}`,
			);
		} else {
			getLogger().write(
				"DEBUG",
				`[DISCUSSIONS VIEW] No discussion at index ${changeRequestStore.selectedDiscussionIndex()}`,
			);
		}
		return true;
	}

	// x to toggle resolve/unresolve the selected discussion
	if (event.name === "x" && !event.shift && !event.ctrl) {
		getLogger().write(
			"DEBUG",
			`[DISCUSSIONS VIEW] x key pressed for resolve toggle`,
		);
		const discussion =
			sortedDiscussions[changeRequestStore.selectedDiscussionIndex()];
		if (discussion) {
			const isSystemNote =
				discussion.notes.length > 0 && discussion.notes[0].system;
			if (isSystemNote) {
				showError(
					"System Event",
					"Cannot resolve system events. Only user comments can be resolved.",
				);
				return true;
			}
			const resolvableNotes = discussion.notes.filter((n) => n.resolvable);
			if (resolvableNotes.length === 0) {
				showError(
					"Not Resolvable",
					"This discussion cannot be resolved (no resolvable notes).",
				);
				return true;
			}
			const currentlyResolved = resolvableNotes.every((n) => n.resolved);
			getLogger().write(
				"INFO",
				`Toggling discussion ${discussion.id} resolved state from ${currentlyResolved} to ${!currentlyResolved}`,
			);
			crActions.resolveDiscussion(
				discussion.id,
				currentlyResolved ? "unresolve" : "resolve",
			);
		} else {
			getLogger().write(
				"DEBUG",
				`[DISCUSSIONS VIEW] No discussion at index ${changeRequestStore.selectedDiscussionIndex()}`,
			);
		}
		return true;
	}

	// j or Down to move down
	if (isDownKey(event)) {
		if (changeRequestStore.selectedDiscussionIndex() < totalDiscussions - 1) {
			changeRequestStore.setSelectedDiscussionIndex((prev) => prev + 1);
		}
		return true;
	}

	// k or Up to move up
	if (isUpKey(event)) {
		if (changeRequestStore.selectedDiscussionIndex() > 0) {
			changeRequestStore.setSelectedDiscussionIndex((prev) => prev - 1);
		}
		return true;
	}

	// g to go to first
	if (event.name === "g" || event.sequence === "g") {
		changeRequestStore.setSelectedDiscussionIndex(0);
		return true;
	}

	// G to go to last
	if (event.name === "G" || event.sequence === "G") {
		changeRequestStore.setSelectedDiscussionIndex(
			Math.max(0, totalDiscussions - 1),
		);
		return true;
	}

	return true;
}
