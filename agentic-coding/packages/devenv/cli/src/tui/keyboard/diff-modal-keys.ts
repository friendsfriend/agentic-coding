import { getLogger } from "@devenv/core";
import {
	handleHorizontalScrollKey,
	isNextRelatedKey,
	isPreviousRelatedKey,
} from "./horizontal-scroll";

import { isDownKey, isUpKey } from "./nav-keys";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types";
/**
 * Handles keyboard events for the Diff modal:
 * - Comment modal (on top of diff)
 * - Reply mode (below comment modal)
 * - Visual selection mode
 * - Line/file navigation
 * - Comment creation & navigation
 * - Open file in editor
 */
export async function handleDiffModalKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
	ctx: KeyboardContext,
): Promise<boolean> {
	const { changeRequestStore, appStore } = stores;
	const { crActions, utilActions } = actions;
	const { showError, getSelectedApp } = ctx;

	if (!changeRequestStore.showDiffModal()) return false;

	// CHECK COMMENT MODAL FIRST (it's on top of diff modal)
	if (changeRequestStore.showCommentModal()) {
		// ESC to cancel comment
		if (
			event.name === "escape" ||
			event.name === "Escape" ||
			event.name === "esc"
		) {
			changeRequestStore.setShowCommentModal(false);
			changeRequestStore.setCommentText("");
			return true;
		}

		// Ctrl+Enter to submit comment (only if not already submitting)
		if (
			event.ctrl &&
			(event.name === "return" ||
				event.name === "enter" ||
				event.name === "Return" ||
				event.name === "Enter")
		) {
			if (!changeRequestStore.commentSubmitting()) {
				crActions.submitComment();
			}
			return true;
		}

		// Enter inserts a line break; Ctrl+Enter submits.
		if (
			event.name === "return" ||
			event.name === "enter" ||
			event.name === "Return" ||
			event.name === "Enter"
		) {
			changeRequestStore.setCommentText(
				`${changeRequestStore.commentText()}\n`,
			);
			return true;
		}

		// Backspace to delete last character
		if (event.name === "backspace" || event.name === "Backspace") {
			changeRequestStore.setCommentText(
				changeRequestStore.commentText().slice(0, -1),
			);
			return true;
		}

		// Regular text input (printable characters)
		if (
			event.sequence &&
			event.sequence.length === 1 &&
			event.sequence >= " " &&
			!event.ctrl &&
			!event.meta
		) {
			changeRequestStore.setCommentText(
				changeRequestStore.commentText() + event.sequence,
			);
			return true;
		}

		// Fallback for terminals that only populate event.name
		if (event.name && event.name.length === 1 && !event.ctrl && !event.meta) {
			changeRequestStore.setCommentText(
				changeRequestStore.commentText() + event.name,
			);
			return true;
		}

		return true;
	}

	// CHECK REPLY MODE SECOND (below comment modal but above diff modal)
	if (changeRequestStore.replyMode()) {
		// ESC to cancel reply
		if (
			event.name === "escape" ||
			event.name === "Escape" ||
			event.name === "esc"
		) {
			changeRequestStore.setReplyMode(null);
			changeRequestStore.setReplyText("");
			getLogger().write("INFO", "Reply mode cancelled");
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
		if (
			event.sequence &&
			event.sequence.length === 1 &&
			event.sequence >= " " &&
			!event.ctrl &&
			!event.meta
		) {
			changeRequestStore.setReplyText(
				changeRequestStore.replyText() + event.sequence,
			);
			return true;
		}

		// Fallback for terminals that only populate event.name
		if (event.name && event.name.length === 1 && !event.ctrl && !event.meta) {
			changeRequestStore.setReplyText(
				changeRequestStore.replyText() + event.name,
			);
			return true;
		}

		return true; // Block all other keys when reply mode is active
	}

	// DIFF MODAL HANDLING (when comment modal is NOT open)
	const changes = changeRequestStore.crChanges();

	// Debug: Log all key presses in diff modal
	getLogger().write(
		"DEBUG",
		`[DIFF MODAL] Key pressed: name="${event.name}", ctrl=${event.ctrl}, shift=${event.shift}, alt=${event.meta}`,
	);

	// ESC to close modal
	if (
		event.name === "escape" ||
		event.name === "Escape" ||
		event.name === "esc"
	) {
		changeRequestStore.setShowDiffModal(false);
		changeRequestStore.setCurrentDiffFile(null);
		changeRequestStore.setDiffModalSelectedLine(0);
		changeRequestStore.setDiffModalVisualMode(false);
		changeRequestStore.setDiffModalVisualStart(0);
		changeRequestStore.setDiffModalForceSplitView(false);

		// Return to previous view if it was discussions view
		if (appStore.previousViewMode() === "discussionsView") {
			appStore.pushView("discussionsView");
			appStore.setPreviousViewMode(null);
		}

		return true;
	}

	// v to toggle visual selection mode (vim-style)
	if (event.name === "v") {
		if (changeRequestStore.diffModalVisualMode()) {
			changeRequestStore.setDiffModalVisualMode(false);
		} else {
			changeRequestStore.setDiffModalVisualMode(true);
			changeRequestStore.setDiffModalVisualStart(
				changeRequestStore.diffModalSelectedLine(),
			);
		}
		return true;
	}

	// c to create a code review comment on selected line(s)
	if (event.name === "c") {
		const selectedLine = changeRequestStore.diffModalSelectedLine();
		if (selectedLine < 0) {
			getLogger().write(
				"DEBUG",
				`c pressed but selectedLine < 0: ${selectedLine}`,
			);
			return true;
		}

		getLogger().write(
			"DEBUG",
			`Opening comment modal for line ${selectedLine}`,
		);

		try {
			changeRequestStore.setCommentText("");
			getLogger().write(
				"DEBUG",
				`About to call changeRequestStore.setShowCommentModal(true)`,
			);
			changeRequestStore.setShowCommentModal(true);
			getLogger().write(
				"DEBUG",
				`Comment modal state set to: ${changeRequestStore.showCommentModal()}`,
			);
		} catch (e) {
			getLogger().write("ERROR", `Failed to set comment modal: ${e}`);
		}
		return true;
	}

	// r to reply to a comment at current line
	if (event.name === "r" && !event.shift) {
		const discussion = crActions.getDiscussionAtCurrentLine();
		if (discussion) {
			changeRequestStore.setReplyMode(discussion.id);
			changeRequestStore.setReplyText("");
			getLogger().write(
				"INFO",
				`Entering reply mode for discussion ${discussion.id}`,
			);
		} else {
			showError("No Comment", "No comment found at this line to reply to");
		}
		return true;
	}

	// Shift+R to resolve/unresolve a discussion at current line
	if (event.name === "r" && event.shift) {
		getLogger().write(
			"DEBUG",
			`Shift+R pressed, event.name="${event.name}", shift=${event.shift}`,
		);
		const discussion = crActions.getDiscussionAtCurrentLine();
		if (discussion) {
			const currentlyResolved = discussion.notes[0]?.resolved || false;
			getLogger().write(
				"INFO",
				`Toggling discussion ${discussion.id} resolved state from ${currentlyResolved} to ${!currentlyResolved}`,
			);
			crActions.resolveDiscussion(
				discussion.id,
				currentlyResolved ? "unresolve" : "resolve",
			);
		} else {
			showError("No Comment", "No comment found at this line to resolve");
		}
		return true;
	}

	// t to toggle collapse/expand thread at current line
	if (event.name === "t") {
		const discussion = crActions.getDiscussionAtCurrentLine();
		if (discussion && discussion.notes.length > 1) {
			changeRequestStore.setCollapsedThreads((prev) => {
				const next = new Set(prev);
				if (next.has(discussion.id)) {
					next.delete(discussion.id);
					getLogger().write("INFO", `Expanded thread ${discussion.id}`);
				} else {
					next.add(discussion.id);
					getLogger().write("INFO", `Collapsed thread ${discussion.id}`);
				}
				return next;
			});
		} else if (discussion) {
			showError("Single Comment", "This comment has no replies to collapse");
		} else {
			showError("No Comment", "No comment found at this line to collapse");
		}
		return true;
	}

	// Shift+N to jump to previous line with a comment
	if (
		event.name === "N" ||
		event.sequence === "N" ||
		(event.name === "n" && event.shift)
	) {
		getLogger().write(
			"DEBUG",
			`[DIFF MODAL] Shift+N pressed: name="${event.name}", sequence="${event.sequence}", shift=${event.shift}`,
		);
		const linesWithComments = crActions.getLinesWithComments();
		if (linesWithComments.length === 0) {
			showError("No Comments", "No comments found in this diff");
			return true;
		}

		const currentLine = changeRequestStore.diffModalSelectedLine();
		let prevLine: number | undefined;
		for (let i = linesWithComments.length - 1; i >= 0; i--) {
			if (linesWithComments[i] < currentLine) {
				prevLine = linesWithComments[i];
				break;
			}
		}

		if (prevLine !== undefined) {
			changeRequestStore.setDiffModalSelectedLine(prevLine);
		} else {
			const lastComment = linesWithComments[linesWithComments.length - 1];
			if (lastComment !== currentLine) {
				changeRequestStore.setDiffModalSelectedLine(lastComment);
			}
		}
		return true;
	}

	// n to jump to next line with a comment (lowercase n only)
	if (event.name === "n" || event.sequence === "n") {
		getLogger().write(
			"DEBUG",
			`[DIFF MODAL] n pressed: name="${event.name}", sequence="${event.sequence}", shift=${event.shift}`,
		);
		const linesWithComments = crActions.getLinesWithComments();
		getLogger().write(
			"DEBUG",
			`[DIFF MODAL] Lines with comments: [${linesWithComments.join(", ")}]`,
		);

		if (linesWithComments.length === 0) {
			showError("No Comments", "No comments found in this diff");
			return true;
		}

		const currentLine = changeRequestStore.diffModalSelectedLine();
		getLogger().write("DEBUG", `[DIFF MODAL] Current line: ${currentLine}`);

		const nextLine = linesWithComments.find((line) => line > currentLine);
		getLogger().write("DEBUG", `[DIFF MODAL] Next line found: ${nextLine}`);

		if (nextLine !== undefined) {
			getLogger().write(
				"DEBUG",
				`[DIFF MODAL] Jumping to next line: ${nextLine}`,
			);
			changeRequestStore.setDiffModalSelectedLine(nextLine);
		} else {
			const firstComment = linesWithComments[0];
			getLogger().write(
				"DEBUG",
				`[DIFF MODAL] No next line, wrapping. First comment: ${firstComment}, current: ${currentLine}`,
			);
			if (firstComment !== currentLine) {
				getLogger().write(
					"DEBUG",
					`[DIFF MODAL] Wrapping to first comment: ${firstComment}`,
				);
				changeRequestStore.setDiffModalSelectedLine(firstComment);
			} else {
				getLogger().write(
					"DEBUG",
					`[DIFF MODAL] Already on first comment, staying put`,
				);
			}
		}
		return true;
	}

	// j or Down to move down one line in diff
	if (isDownKey(event)) {
		changeRequestStore.setDiffModalSelectedLine(
			changeRequestStore.diffModalSelectedLine() + 1,
		);
		return true;
	}

	// k or Up to move up one line in diff
	if (isUpKey(event)) {
		changeRequestStore.setDiffModalSelectedLine(
			Math.max(changeRequestStore.diffModalSelectedLine() - 1, 0),
		);
		return true;
	}

	if (
		handleHorizontalScrollKey(event, changeRequestStore.diffModalScrollBoxRef)
	)
		return true;

	// [ or Shift+K to go to previous file
	if (isPreviousRelatedKey(event)) {
		const newIndex = Math.max(
			changeRequestStore.selectedChangedFileIndex() - 1,
			0,
		);
		if (newIndex !== changeRequestStore.selectedChangedFileIndex()) {
			changeRequestStore.setSelectedChangedFileIndex(newIndex);
			changeRequestStore.setDiffModalSelectedLine(0);
			changeRequestStore.setDiffModalVisualMode(false);
			changeRequestStore.setDiffModalVisualStart(0);
			const selectedChange = changes[newIndex];
			if (selectedChange?.diff) {
				changeRequestStore.setCurrentDiffFile(selectedChange);
			}
		}
		return true;
	}

	// ] or Shift+J to go to next file
	if (isNextRelatedKey(event)) {
		const newIndex = Math.min(
			changeRequestStore.selectedChangedFileIndex() + 1,
			changes.length - 1,
		);
		if (newIndex !== changeRequestStore.selectedChangedFileIndex()) {
			changeRequestStore.setSelectedChangedFileIndex(newIndex);
			changeRequestStore.setDiffModalSelectedLine(0);
			changeRequestStore.setDiffModalVisualMode(false);
			changeRequestStore.setDiffModalVisualStart(0);
			const selectedChange = changes[newIndex];
			if (selectedChange?.diff) {
				changeRequestStore.setCurrentDiffFile(selectedChange);
			}
		}
		return true;
	}

	// s to toggle split / staggered view — always a plain flip since the initial
	// value is pre-calculated at modal open time (never null during normal use).
	if (event.name === "s") {
		changeRequestStore.setDiffModalForceSplitView(
			!changeRequestStore.diffModalForceSplitView(),
		);
		return true;
	}

	// e — open current diff file in editor, jumping to the first changed line
	if (event.name === "e") {
		const diffFile = changeRequestStore.currentDiffFile();
		const app = getSelectedApp();
		if (diffFile && app?.localDirectoryPath) {
			const { join } = require("node:path") as typeof import("path");
			const filePath = join(app.localDirectoryPath, diffFile.new_path);

			let firstChangedLine: number | undefined;
			if (diffFile.diff) {
				let newLineNum = 0;
				for (const line of diffFile.diff.split("\n")) {
					if (line.startsWith("@@")) {
						const m = line.match(/@@ -\d+,?\d* \+(\d+),?\d* @@/);
						if (m) newLineNum = parseInt(m[1], 10) - 1;
					} else if (line.startsWith("+") && !line.startsWith("+++")) {
						newLineNum++;
						firstChangedLine = newLineNum;
						break;
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						firstChangedLine = newLineNum + 1;
						break;
					} else if (!line.startsWith("---") && !line.startsWith("+++")) {
						newLineNum++;
					}
				}
			}

			utilActions.openInEditor(filePath, firstChangedLine);
		}
		return true;
	}

	// Block all other keys when modal is open - consume the event
	return true;
}
