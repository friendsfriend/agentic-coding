import { isDownKey, isUpKey } from "./nav-keys";
import {
	isNextPanelKey,
	isPrevPanelKey,
	nextPanelIndex,
	prevPanelIndex,
} from "./panel-keys";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types";

export async function handleIssueDetailKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
	_ctx: KeyboardContext,
): Promise<boolean> {
	const { appStore, issueStore } = stores;
	const { issueActions } = actions;

	if (appStore.viewMode() !== "issueDetail") {
		return false;
	}

	const issue = issueStore.selectedIssue();
	if (!issue) {
		return false;
	}

	// ─── Modal states take priority ──────────────────────────────────────────

	// Label picker modal
	if (issueStore.showLabelPicker()) {
		if (isDownKey(event)) {
			const idx = issueStore.labelPickerIndex();
			const labels = issueStore.availableLabels();
			issueStore.setLabelPickerIndex(Math.min(idx + 1, labels.length - 1));
			return true;
		}
		if (isUpKey(event)) {
			const idx = issueStore.labelPickerIndex();
			issueStore.setLabelPickerIndex(Math.max(idx - 1, 0));
			return true;
		}
		if (event.name === "space" || event.sequence === " ") {
			const idx = issueStore.labelPickerIndex();
			const labels = issueStore.availableLabels();
			const selectedLabel = labels[idx];
			if (selectedLabel) {
				const selected = issueStore.labelPickerSelectedLabels();
				issueStore.setLabelPickerSelectedLabels(
					selected.includes(selectedLabel)
						? selected.filter((label) => label !== selectedLabel)
						: [...selected, selectedLabel],
				);
			}
			return true;
		}
		if (event.name === "enter" || event.name === "return") {
			issueActions.setIssueLabels(
				issue.iid,
				issueStore.labelPickerSelectedLabels(),
			);
			return true;
		}
		if (event.name === "escape" || event.name === "q") {
			issueStore.setShowLabelPicker(false);
			return true;
		}
		return true;
	}

	// Assignee picker modal
	if (issueStore.showAssigneePicker()) {
		if (isDownKey(event)) {
			const idx = issueStore.assigneePickerIndex();
			const collabs = issueStore.availableCollaborators();
			issueStore.setAssigneePickerIndex(Math.min(idx + 1, collabs.length - 1));
			return true;
		}
		if (isUpKey(event)) {
			const idx = issueStore.assigneePickerIndex();
			issueStore.setAssigneePickerIndex(Math.max(idx - 1, 0));
			return true;
		}
		if (event.name === "enter" || event.name === "return") {
			const idx = issueStore.assigneePickerIndex();
			const collabs = issueStore.availableCollaborators();
			const selectedCollab = collabs[idx];
			if (selectedCollab) {
				const currentAssignee = (issue.assignees ?? [])[0]?.username;
				if (selectedCollab === currentAssignee) {
					issueActions.removeIssueAssignee(issue.iid);
				} else {
					issueActions.setIssueAssignee(issue.iid, selectedCollab);
				}
			}
			return true;
		}
		if (event.name === "escape" || event.name === "q") {
			issueStore.setShowAssigneePicker(false);
			return true;
		}
		return true;
	}

	// Comment modal
	if (issueStore.showCommentModal()) {
		// Backspace - delete last char
		if (event.name === "backspace") {
			issueStore.setCommentText((prev) => prev.slice(0, -1));
			return true;
		}
		// Ctrl+Enter - submit
		if (
			(event.ctrl && event.name === "enter") ||
			(event.ctrl && event.name === "return")
		) {
			issueActions.addComment();
			return true;
		}
		// Enter - newline (append \n)
		if (event.name === "enter" || event.name === "return") {
			issueStore.setCommentText((prev) => `${prev}\n`);
			return true;
		}
		// Printable characters - append to text
		if (
			event.sequence &&
			event.sequence.length === 1 &&
			event.sequence.charCodeAt(0) >= 32
		) {
			const sequence = event.sequence;
			issueStore.setCommentText((prev) => prev + sequence);
			return true;
		}
		if (event.name === "escape" || event.name === "q") {
			issueStore.setShowCommentModal(false);
			issueStore.setCommentText("");
			return true;
		}
		return true;
	}

	// Close reason modal
	if (issueStore.showCloseReasonModal()) {
		const REASON_VALUES = ["completed", "not_planned", ""];
		if (isDownKey(event)) {
			issueStore.setCloseReasonIndex(
				Math.min(issueStore.closeReasonIndex() + 1, 2),
			);
			return true;
		}
		if (isUpKey(event)) {
			issueStore.setCloseReasonIndex(
				Math.max(issueStore.closeReasonIndex() - 1, 0),
			);
			return true;
		}
		if (event.name === "enter" || event.name === "return") {
			const idx = issueStore.closeReasonIndex();
			issueStore.setShowCloseReasonModal(false);
			issueActions.closeIssue(issue.iid, REASON_VALUES[idx]);
			return true;
		}
		if (event.name === "escape" || event.name === "q") {
			issueStore.setShowCloseReasonModal(false);
			return true;
		}
		return true;
	}

	// ─── Normal mode keybinds ───────────────────────────────────────────────

	if (event.name === "escape" || event.name === "q") {
		issueActions.abortViewLoads();
		issueActions.backToIssueList();
		return true;
	}

	// ─── Panel focus navigation ─────────────────────────────────────────────
	const panelCount = issueStore.issueDetailPanelCount;
	if (panelCount > 1) {
		if (isNextPanelKey(event)) {
			issueStore.setIssueDetailPanelIndex((prev) =>
				nextPanelIndex(prev, panelCount),
			);
			return true;
		}
		if (isPrevPanelKey(event)) {
			issueStore.setIssueDetailPanelIndex((prev) =>
				prevPanelIndex(prev, panelCount),
			);
			return true;
		}
	}

	// Vertical scrolling within the focused panel
	const refs = issueStore.issueDetailScrollBoxRefs;
	const activeRef = refs[issueStore.issueDetailPanelIndex()];
	if (isDownKey(event)) {
		activeRef?.scrollBy(1);
		if (activeRef) return true;
	}
	if (isUpKey(event)) {
		activeRef?.scrollBy(-1);
		if (activeRef) return true;
	}
	if (event.name === "d" || event.sequence === "d") {
		const half = Math.max(
			1,
			Math.floor((activeRef?.viewport.height ?? 10) / 2),
		);
		activeRef?.scrollBy(half);
		if (activeRef) return true;
	}
	if (event.name === "u" || event.sequence === "u") {
		const half = Math.max(
			1,
			Math.floor((activeRef?.viewport.height ?? 10) / 2),
		);
		activeRef?.scrollBy(-half);
		if (activeRef) return true;
	}
	if ((event.name === "g" || event.sequence === "g") && !event.shift) {
		activeRef?.scrollTo(0);
		if (activeRef) return true;
	}
	if (
		event.name === "G" ||
		event.sequence === "G" ||
		(event.name === "g" && event.shift)
	) {
		activeRef?.scrollTo(activeRef?.scrollHeight ?? 0);
		if (activeRef) return true;
	}

	// o - Open detail view for the focused panel
	if (
		event.sequence === "o" ||
		(event.name === "o" && !event.shift && !event.ctrl)
	) {
		const panelIdx = issueStore.issueDetailPanelIndex();
		switch (panelIdx) {
			case 1: // References — open combined references view
				issueStore.setSelectedReferenceIndex(0);
				issueActions.showReferencesSubView();
				return true;
		}
	}

	// c - Close issue (opens reason picker)
	if (event.name === "c" && !event.ctrl && !event.shift) {
		if (issue.state === "closed") {
			return true;
		}
		issueStore.setCloseReasonIndex(0);
		issueStore.setShowCloseReasonModal(true);
		return true;
	}

	// C (Shift+C) - Reopen issue (no confirmation)
	if ((event.name === "c" && event.shift) || event.name === "C") {
		const alreadyOpen = issue.state === "open" || issue.state === "opened";
		if (alreadyOpen) {
			return true;
		}
		issueActions.reopenIssue(issue.iid);
		return true;
	}

	// Shift+L - Open label picker
	if (
		(event.name === "L" ||
			event.sequence === "L" ||
			(event.name === "l" && event.shift)) &&
		!event.ctrl
	) {
		issueActions.openLabelPicker();
		return true;
	}

	// a - Open assignee picker
	if (event.name === "a" && !event.ctrl) {
		issueActions.openAssigneePicker();
		return true;
	}

	// R (Shift+R) — Open combined references sub-view (must be before lowercase r)
	if ((event.name === "r" && event.shift) || event.name === "R") {
		issueStore.setSelectedReferenceIndex(0);
		issueActions.showReferencesSubView();
		return true;
	}

	// t — Open full timeline view
	if (event.name === "t" && !event.ctrl && !event.shift) {
		appStore.pushView("issueTimeline");
		issueStore.setSelectedTimelineIndex(0);
		return true;
	}

	// r — Add comment (reply)
	if (event.name === "r" && !event.ctrl && !event.shift) {
		issueActions.openCommentModal();
		return true;
	}

	// M (Shift+M) - Open linked CRs sub-view
	if ((event.name === "m" && event.shift) || event.name === "M") {
		issueStore.setSelectedLinkedCRIndex(0);
		issueActions.showLinkedCRsSubView();
		return true;
	}

	// I (Shift+I) - Open referenced issues sub-view
	if ((event.name === "i" && event.shift) || event.name === "I") {
		issueStore.setSelectedReferencedIssueIndex(0);
		issueActions.showReferencedIssuesSubView();
		return true;
	}

	return true;
}
