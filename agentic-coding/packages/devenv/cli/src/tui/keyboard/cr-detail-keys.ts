import { getLogger } from "@devenv/core";
import {
	isNextPanelKey,
	isPrevPanelKey,
	nextPanelIndex,
	prevPanelIndex,
} from "./";
import { isDownKey, isUpKey } from "./nav-keys.ts";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types.ts";

/** Handles keyboard events for the CR detail view. */
export async function handleCrDetailKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
	_ctx: KeyboardContext,
): Promise<boolean> {
	const { appStore, changeRequestStore } = stores;
	const { crActions, helpActions } = actions;

	if (appStore.viewMode() !== "changeRequestDetail") return false;

	getLogger().write(
		"DEBUG",
		`[CR DETAIL] Key: name="${event.name}", sequence="${event.sequence}", shift=${event.shift}, ctrl=${event.ctrl}`,
	);

	// --- Panel focus navigation ---
	const panelCount = changeRequestStore.crDetailPanelCount;
	if (panelCount > 1) {
		if (isNextPanelKey(event)) {
			changeRequestStore.setCrDetailPanelIndex((prev) =>
				nextPanelIndex(prev, panelCount),
			);
			return true;
		}
		if (isPrevPanelKey(event)) {
			changeRequestStore.setCrDetailPanelIndex((prev) =>
				prevPanelIndex(prev, panelCount),
			);
			return true;
		}
	}

	// When a scrollable panel is focused, delegate j/k to its scrollbox ref
	if (isDownKey(event)) {
		const refs = changeRequestStore.crDetailScrollBoxRefs;
		const ref = refs[changeRequestStore.crDetailPanelIndex()];
		ref?.scrollBy(1);
		if (ref) return true;
	}
	if (isUpKey(event)) {
		const refs = changeRequestStore.crDetailScrollBoxRefs;
		const ref = refs[changeRequestStore.crDetailPanelIndex()];
		ref?.scrollBy(-1);
		if (ref) return true;
	}

	// --- 'o' opens panel detail view ---
	if (
		event.sequence === "o" ||
		(event.name === "o" && !event.shift && !event.ctrl)
	) {
		const panelIdx = changeRequestStore.crDetailPanelIndex();
		switch (panelIdx) {
			case 2: // Changed Files
				if (changeRequestStore.crChanges().length > 0) {
					changeRequestStore.setSelectedChangedFileIndex(0);
					appStore.pushView("changedFiles");
				}
				return true;
			case 3: // Pipeline Jobs — open full jobs view
				if ((changeRequestStore.crJobsForDetail()?.length ?? 0) > 0) {
					appStore.pushView("jobs");
				}
				return true;
			case 4: // Linked Issues
				changeRequestStore.setSelectedCrLinkedIssueIndex(0);
				appStore.pushView("changeRequestLinkedIssues");
				return true;
			case 5: {
				// Discussions
				const discussions = changeRequestStore.crDiscussions();
				if (Array.isArray(discussions) && discussions.length > 0) {
					changeRequestStore.setSelectedDiscussionIndex(0);
					changeRequestStore.setDiscussionsShowOnlyComments(false);
					appStore.pushView("discussionsView");
				}
				return true;
			}
			case 6: {
				// Test Results
				const testData = changeRequestStore.crTestSummary();
				if (testData?.test_suites?.length) {
					appStore.pushView("testResults");
				}
				return true;
			}
		}
	}

	// --- Normal CR detail keys ---

	if (event.name === "?" || event.sequence === "?") {
		helpActions.showHelp();
		return true;
	}

	if (event.sequence === "C") {
		const changes = changeRequestStore.crChanges();
		if (changes && changes.length > 0) {
			changeRequestStore.setSelectedChangedFileIndex(0);
			appStore.pushView("changedFiles");
		}
		return true;
	}

	if (event.sequence === "T") {
		const testData = changeRequestStore.crTestSummary();
		if (testData?.test_suites?.length) appStore.pushView("testResults");
		return true;
	}

	if (event.sequence === "D") {
		getLogger().write(
			"DEBUG",
			`Shift+D pressed! event.sequence="${event.sequence}"`,
		);
		const discussions = changeRequestStore.crDiscussions();
		getLogger().write(
			"DEBUG",
			`Discussions count: ${discussions?.length || 0}`,
		);
		try {
			if (Array.isArray(discussions) && discussions.length > 0) {
				changeRequestStore.setSelectedDiscussionIndex(0);
				changeRequestStore.setDiscussionsShowOnlyComments(false);
				appStore.pushView("discussionsView");
				getLogger().write(
					"INFO",
					`Switched to discussionsView mode with ${discussions.length} discussions`,
				);
			}
		} catch (e) {
			getLogger().write("ERROR", `Error switching to discussions view: ${e}`);
		}
		return true;
	}

	// 'a' (lowercase only) — toggle approval
	if (event.name === "a" && event.sequence !== "A") {
		await crActions.toggleCRApproval();
		return true;
	}

	if (event.name === "r") {
		await crActions.rebaseCR();
		return true;
	}

	// I (Shift+I) — open linked issues sub-view
	if ((event.name === "i" && event.shift) || event.name === "I") {
		changeRequestStore.setSelectedCrLinkedIssueIndex(0);
		appStore.pushView("changeRequestLinkedIssues");
		return true;
	}

	if (
		event.name === "escape" ||
		event.name === "Escape" ||
		event.name === "esc" ||
		event.sequence === "\x1b" ||
		event.raw === "\x1b"
	) {
		crActions.abortViewLoads();
		crActions.backToCRList();
		return true;
	}

	return true;
}
