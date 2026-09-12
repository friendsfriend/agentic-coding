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
 * Handles keyboard events for the Changed Files view:
 * - Search mode (type query, clear)
 * - / to search, ESC to go back
 * - Shift+D to switch to discussions view
 * - Enter to open diff modal
 * - j/k/g/G for navigation
 */
export async function handleChangedFilesKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	_actions: KeyboardActions,
	ctx: KeyboardContext,
): Promise<boolean> {
	const { appStore, changeRequestStore } = stores;
	if (appStore.viewMode() !== "changedFiles") return false;

	if (
		changeRequestStore.showListFilterModal() &&
		changeRequestStore.listControlTarget() === "changedFiles"
	) {
		const params = changeRequestStore.listFilterParameters();
		const param = params[changeRequestStore.listFilterParameterIndex()];
		const values = param?.values ?? [];
		if (
			event.name === "escape" ||
			event.name === "esc" ||
			event.sequence === "\x1b" ||
			event.name === "return" ||
			event.name === "enter"
		) {
			changeRequestStore.setShowListFilterModal(false);
			changeRequestStore.setSelectedChangedFileIndex(0);
			return true;
		}
		if (event.name === "x") {
			changeRequestStore.setCurrentListFilters({});
			changeRequestStore.setSelectedChangedFileIndex(0);
			return true;
		}
		if (isDownKey(event)) {
			if (changeRequestStore.listFilterFocusedPane() === "parameter") {
				changeRequestStore.setListFilterParameterIndex((i) =>
					Math.min(params.length - 1, i + 1),
				);
				changeRequestStore.setListFilterValueIndex(0);
			} else
				changeRequestStore.setListFilterValueIndex((i) =>
					Math.min(values.length - 1, i + 1),
				);
			return true;
		}
		if (isUpKey(event)) {
			if (changeRequestStore.listFilterFocusedPane() === "parameter") {
				changeRequestStore.setListFilterParameterIndex((i) =>
					Math.max(0, i - 1),
				);
				changeRequestStore.setListFilterValueIndex(0);
			} else
				changeRequestStore.setListFilterValueIndex((i) => Math.max(0, i - 1));
			return true;
		}
		if (event.name === "right" || event.sequence === "l") {
			changeRequestStore.setListFilterFocusedPane("value");
			return true;
		}
		if (event.name === "left" || event.sequence === "h") {
			changeRequestStore.setListFilterFocusedPane("parameter");
			return true;
		}
		if (
			event.sequence === " " &&
			param &&
			values[changeRequestStore.listFilterValueIndex()]
		) {
			const value = values[changeRequestStore.listFilterValueIndex()].value;
			changeRequestStore.setCurrentListFilters((filters) => {
				const current = filters[param.key] ?? [];
				return {
					...filters,
					[param.key]: current.includes(value)
						? current.filter((v) => v !== value)
						: [...current, value],
				};
			});
			changeRequestStore.setSelectedChangedFileIndex(0);
			return true;
		}
		return true;
	}

	if (
		changeRequestStore.showListSortModal() &&
		changeRequestStore.listControlTarget() === "changedFiles"
	) {
		const rules = changeRequestStore.currentListSortRules();
		const selected = changeRequestStore.listSortSelectedIndex();
		if (
			event.name === "escape" ||
			event.name === "esc" ||
			event.sequence === "\x1b" ||
			event.name === "return" ||
			event.name === "enter"
		) {
			changeRequestStore.setShowListSortModal(false);
			changeRequestStore.setSelectedChangedFileIndex(0);
			return true;
		}
		if (event.name === "x") {
			changeRequestStore.setCurrentListSortRules(
				rules.map((rule) => ({ ...rule, direction: "none" })),
			);
			changeRequestStore.setSelectedChangedFileIndex(0);
			return true;
		}
		if (isDownKey(event)) {
			changeRequestStore.setListSortSelectedIndex((i) =>
				Math.min(rules.length - 1, i + 1),
			);
			return true;
		}
		if (isUpKey(event)) {
			changeRequestStore.setListSortSelectedIndex((i) => Math.max(0, i - 1));
			return true;
		}
		if (event.sequence === " ") {
			const order = ["asc", "desc", "none"] as const;
			changeRequestStore.setCurrentListSortRules((current) =>
				current.map((rule, index) =>
					index === selected
						? {
								...rule,
								direction:
									order[(order.indexOf(rule.direction) + 1) % order.length],
							}
						: rule,
				),
			);
			changeRequestStore.setSelectedChangedFileIndex(0);
			return true;
		}
		if (event.sequence === "K" && selected > 0) {
			changeRequestStore.setCurrentListSortRules((current) => {
				const next = [...current];
				[next[selected - 1], next[selected]] = [
					next[selected],
					next[selected - 1],
				];
				return next;
			});
			changeRequestStore.setListSortSelectedIndex(selected - 1);
			return true;
		}
		if (event.sequence === "J" && selected < rules.length - 1) {
			changeRequestStore.setCurrentListSortRules((current) => {
				const next = [...current];
				[next[selected], next[selected + 1]] = [
					next[selected + 1],
					next[selected],
				];
				return next;
			});
			changeRequestStore.setListSortSelectedIndex(selected + 1);
			return true;
		}
		return true;
	}

	// Changed files search mode — capture all keys while user is typing
	if (changeRequestStore.changedFilesSearchMode()) {
		if (
			event.name === "escape" ||
			event.name === "Escape" ||
			event.name === "esc" ||
			event.sequence === "\x1b"
		) {
			changeRequestStore.setChangedFilesSearchMode(false);
			changeRequestStore.setChangedFilesSearchQuery("");
			changeRequestStore.setSelectedChangedFileIndex(0);
			return true;
		}
		if (event.name === "return" || event.name === "enter") {
			changeRequestStore.setChangedFilesSearchMode(false);
			changeRequestStore.setSelectedChangedFileIndex(0);
			return true;
		}
		if (event.name === "backspace" || event.name === "delete") {
			changeRequestStore.setChangedFilesSearchQuery((q) => q.slice(0, -1));
			changeRequestStore.setSelectedChangedFileIndex(0);
			return true;
		}
		const ch = event.sequence ?? event.name ?? "";
		if (ch.length === 1 && ch >= " ") {
			changeRequestStore.setChangedFilesSearchQuery((q) => q + ch);
			changeRequestStore.setSelectedChangedFileIndex(0);
			return true;
		}
		return true; // swallow all other keys
	}

	if (event.sequence === "F") {
		changeRequestStore.setListControlTarget("changedFiles");
		changeRequestStore.setListFilterParameterIndex(0);
		changeRequestStore.setListFilterValueIndex(0);
		changeRequestStore.setListFilterFocusedPane("parameter");
		changeRequestStore.setShowListFilterModal(true);
		return true;
	}

	if (event.sequence === "O") {
		changeRequestStore.setListControlTarget("changedFiles");
		changeRequestStore.setListSortSelectedIndex(0);
		changeRequestStore.setShowListSortModal(true);
		return true;
	}

	// '/' to enter search mode
	if (event.name === "/" || event.sequence === "/") {
		changeRequestStore.setChangedFilesSearchMode(true);
		changeRequestStore.setChangedFilesSearchQuery("");
		changeRequestStore.setSelectedChangedFileIndex(0);
		return true;
	}

	// ESC: clear search first, then go back to CR detail
	if (
		event.name === "escape" ||
		event.name === "Escape" ||
		event.name === "esc"
	) {
		if (changeRequestStore.changedFilesSearchQuery()) {
			changeRequestStore.setChangedFilesSearchQuery("");
			changeRequestStore.setChangedFilesSearchMode(false);
			changeRequestStore.setSelectedChangedFileIndex(0);
			return true;
		}
		changeRequestStore.setSelectedChangedFileIndex(0);
		appStore.popView();
		return true;
	}

	// Shift+D to switch to Discussions view
	if (
		event.sequence === "D" ||
		event.name === "D" ||
		(event.name === "d" && event.shift)
	) {
		getLogger().write(
			"DEBUG",
			`[CHANGED FILES VIEW] Shift+D detected! Switching to discussionsView`,
		);
		changeRequestStore.setDiscussionsShowOnlyComments(false);
		appStore.pushView("discussionsView");
		changeRequestStore.setSelectedDiscussionIndex(0);
		return true;
	}

	const changes = changeRequestStore.changedFilesFiltered();
	if (changes.length === 0) return true;

	if (event.name === "return" || event.name === "enter") {
		const selectedChange =
			changes[changeRequestStore.selectedChangedFileIndex()];
		if (selectedChange?.diff) {
			changeRequestStore.setCurrentDiffFile(selectedChange);
			changeRequestStore.setDiffModalSelectedLine(0);
			changeRequestStore.setDiffModalVisualMode(false);
			changeRequestStore.setDiffModalVisualStart(0);
			changeRequestStore.setDiffModalForceSplitView(
				computeInitialSplitView(
					selectedChange.diff,
					ctx.renderer.width,
					selectedChange.new_file || selectedChange.deleted_file,
				),
			);
			changeRequestStore.setShowDiffModal(true);
		}
		return true;
	}

	// j or Down to move down
	if (isDownKey(event)) {
		changeRequestStore.setSelectedChangedFileIndex((prev) =>
			Math.min(prev + 1, changes.length - 1),
		);
		return true;
	}

	// k or Up to move up
	if (isUpKey(event)) {
		changeRequestStore.setSelectedChangedFileIndex((prev) =>
			Math.max(prev - 1, 0),
		);
		return true;
	}

	// g to go to top
	if (event.name === "g" || event.sequence === "g") {
		changeRequestStore.setSelectedChangedFileIndex(0);
		return true;
	}

	// G (Shift+G) to go to bottom
	if (event.sequence === "G") {
		changeRequestStore.setSelectedChangedFileIndex(changes.length - 1);
		return true;
	}

	return true;
}
