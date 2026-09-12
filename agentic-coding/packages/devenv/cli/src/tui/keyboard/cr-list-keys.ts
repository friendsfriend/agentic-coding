import { isNextRelatedKey, isPreviousRelatedKey } from "./horizontal-scroll";

import { isDownKey, isLeftKey, isRightKey, isUpKey } from "./nav-keys";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types";
/**
 * Handles keyboard events for the CR list view:
 * - Search mode (type query, clear)
 * - / to search, ESC to go back
 * - Enter to select CR
 * - j/k/g/G for navigation
 */
export async function handleCrListKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
	_ctx: KeyboardContext,
): Promise<boolean> {
	const { appStore, changeRequestStore } = stores;
	const { crActions } = actions;

	if (appStore.viewMode() !== "changeRequests") return false;

	// CR search mode — capture all keys while user is typing
	if (changeRequestStore.crSearchMode()) {
		if (
			event.name === "escape" ||
			event.name === "Escape" ||
			event.name === "esc" ||
			event.sequence === "\x1b"
		) {
			changeRequestStore.setCrSearchMode(false);
			changeRequestStore.setCrSearchQuery("");
			changeRequestStore.setSelectedCRIndex(0);
			return true;
		}
		if (event.name === "return" || event.name === "enter") {
			const query = changeRequestStore.crSearchQuery();
			changeRequestStore.setCrSearchMode(false);
			changeRequestStore.setCrSearchQuery(""); // clear client-side filter so server results aren't double-filtered
			changeRequestStore.setSelectedCRIndex(0);
			if (query) {
				// Submit search to server
				changeRequestStore.setSearchTerm(query);
				crActions.loadAllChangeRequests(1, query);
			}
			return true;
		}
		if (event.name === "backspace" || event.name === "delete") {
			changeRequestStore.setCrSearchQuery((q) => q.slice(0, -1));
			changeRequestStore.setSelectedCRIndex(0);
			return true;
		}
		const ch = event.sequence ?? event.name ?? "";
		if (ch.length === 1 && ch >= " ") {
			changeRequestStore.setCrSearchQuery((q) => q + ch);
			changeRequestStore.setSelectedCRIndex(0);
			return true;
		}
		return true; // swallow all other keys
	}

	if (changeRequestStore.showCrListFilterModal()) {
		const params = changeRequestStore.crListFilterParameters();
		const param = params[changeRequestStore.crListFilterParameterIndex()];
		const values = param?.values ?? [];
		if (event.name === "x") {
			changeRequestStore.setCrListFilters({ state: [] });
			changeRequestStore.setSelectedCRIndex(0);
			void crActions.loadAllChangeRequests(
				1,
				changeRequestStore.searchTerm() || undefined,
			);
			return true;
		}
		if (isLeftKey(event)) {
			changeRequestStore.setCrListFilterFocusedPane("parameter");
			return true;
		}
		if (isRightKey(event)) {
			changeRequestStore.setCrListFilterFocusedPane("value");
			return true;
		}
		if (isDownKey(event)) {
			if (changeRequestStore.crListFilterFocusedPane() === "parameter") {
				changeRequestStore.setCrListFilterParameterIndex(
					Math.min(
						changeRequestStore.crListFilterParameterIndex() + 1,
						params.length - 1,
					),
				);
				changeRequestStore.setCrListFilterValueIndex(0);
			} else
				changeRequestStore.setCrListFilterValueIndex(
					Math.min(
						changeRequestStore.crListFilterValueIndex() + 1,
						values.length - 1,
					),
				);
			return true;
		}
		if (isUpKey(event)) {
			if (changeRequestStore.crListFilterFocusedPane() === "parameter") {
				changeRequestStore.setCrListFilterParameterIndex(
					Math.max(changeRequestStore.crListFilterParameterIndex() - 1, 0),
				);
				changeRequestStore.setCrListFilterValueIndex(0);
			} else
				changeRequestStore.setCrListFilterValueIndex(
					Math.max(changeRequestStore.crListFilterValueIndex() - 1, 0),
				);
			return true;
		}
		if (event.name === "space" || event.sequence === " ") {
			const value = values[changeRequestStore.crListFilterValueIndex()]?.value;
			if (param && value) {
				const filters = { ...changeRequestStore.crListFilters() };
				const current = filters[param.key] ?? [];
				filters[param.key] = current.includes(value)
					? current.filter((item) => item !== value)
					: [value];
				changeRequestStore.setCrListFilters(filters);
				changeRequestStore.setSelectedCRIndex(0);
				void crActions.loadAllChangeRequests(
					1,
					changeRequestStore.searchTerm() || undefined,
				);
			}
			return true;
		}
		if (
			event.name === "enter" ||
			event.name === "return" ||
			event.name === "escape" ||
			event.name === "q"
		) {
			changeRequestStore.setShowCrListFilterModal(false);
			return true;
		}
		return true;
	}

	if (changeRequestStore.showCrListSortModal()) {
		const rules = changeRequestStore.crListSortRules();
		const idx = changeRequestStore.crListSortSelectedIndex();
		const cycle = (d: "asc" | "desc" | "none") =>
			d === "none" ? "asc" : d === "asc" ? "desc" : "none";
		if (event.name === "x") {
			changeRequestStore.setCrListSortRules(
				rules.map((rule) => ({ ...rule, direction: "none" })),
			);
			void crActions.loadAllChangeRequests(
				1,
				changeRequestStore.searchTerm() || undefined,
			);
			return true;
		}
		if (isDownKey(event)) {
			changeRequestStore.setCrListSortSelectedIndex(
				Math.min(idx + 1, rules.length - 1),
			);
			return true;
		}
		if (isUpKey(event)) {
			changeRequestStore.setCrListSortSelectedIndex(Math.max(idx - 1, 0));
			return true;
		}
		if (event.name === "space" || event.sequence === " ") {
			changeRequestStore.setCrListSortRules(
				rules.map((rule, i) =>
					i === idx ? { ...rule, direction: cycle(rule.direction) } : rule,
				),
			);
			void crActions.loadAllChangeRequests(
				1,
				changeRequestStore.searchTerm() || undefined,
			);
			return true;
		}
		if (
			event.name === "enter" ||
			event.name === "return" ||
			event.name === "escape" ||
			event.name === "q"
		) {
			changeRequestStore.setShowCrListSortModal(false);
			return true;
		}
		return true;
	}

	const crs = changeRequestStore.changeRequests();

	if (event.name === "F" || (event.name === "f" && event.shift)) {
		changeRequestStore.setShowCrListFilterModal(true);
		return true;
	}
	if (event.name === "O" || (event.name === "o" && event.shift)) {
		changeRequestStore.setShowCrListSortModal(true);
		return true;
	}

	// '/' to enter search mode
	if (event.name === "/" || event.sequence === "/") {
		changeRequestStore.setCrSearchMode(true);
		changeRequestStore.setCrSearchQuery("");
		changeRequestStore.setSelectedCRIndex(0);
		return true;
	}

	// ESC: clear search first, then go back
	if (
		event.name === "escape" ||
		event.name === "Escape" ||
		event.name === "esc"
	) {
		if (changeRequestStore.crSearchQuery() || changeRequestStore.searchTerm()) {
			changeRequestStore.setCrSearchQuery("");
			changeRequestStore.setSearchTerm("");
			changeRequestStore.setCrSearchMode(false);
			changeRequestStore.setSelectedCRIndex(0);
			// Reload without search filter if we had a server-side search active
			if (changeRequestStore.changeRequests().length > 0) {
				crActions.loadAllChangeRequests(1);
			}
			return true;
		}
		crActions.abortViewLoads();
		appStore.popView();
		changeRequestStore.setChangeRequests([]);
		changeRequestStore.setCrError("");
		changeRequestStore.setSelectedCR(null);
		changeRequestStore.setSelectedCRIndex(0);
		changeRequestStore.setSearchTerm("");
		return true;
	}

	// Enter to select CR
	if (event.name === "return" || event.name === "enter") {
		if (crs.length > 0) {
			const selected = crs[changeRequestStore.selectedChangeRequestIndex()];
			if (selected) {
				crActions.showCRDetail(selected);
			}
		}
		return true;
	}

	// s cycles state filter: opened → merged → closed → all → opened
	if (event.name === "s" && !event.shift && !event.ctrl) {
		const current = changeRequestStore.crListFilters().state?.[0] ?? "opened";
		const next =
			current === "opened"
				? "merged"
				: current === "merged"
					? "closed"
					: current === "closed"
						? "all"
						: "opened";
		changeRequestStore.setCrListFilters({
			...changeRequestStore.crListFilters(),
			state: next === "all" ? [] : [next],
		});
		void crActions.loadAllChangeRequests();
		return true;
	}

	if (crs.length === 0) return true;

	// j or Down to move down
	if (isDownKey(event)) {
		changeRequestStore.setSelectedCRIndex((prev) =>
			Math.min(prev + 1, crs.length - 1),
		);
		return true;
	}

	// k or Up to move up
	if (isUpKey(event)) {
		changeRequestStore.setSelectedCRIndex((prev) => Math.max(prev - 1, 0));
		return true;
	}

	// g to go to top
	if (event.name === "g") {
		changeRequestStore.setSelectedCRIndex(0);
		return true;
	}

	// G (Shift+G) to go to bottom
	if (event.sequence === "G") {
		changeRequestStore.setSelectedCRIndex(crs.length - 1);
		return true;
	}

	// ] or Shift+J to go to next page
	if (isNextRelatedKey(event)) {
		const current = changeRequestStore.currentPage();
		const total = changeRequestStore.totalPages();
		// Only navigate if totalPages is unknown (>0) or we're not at the last page
		if (total <= 0 || current < total) {
			crActions.nextPage();
		}
		return true;
	}

	// [ or Shift+K to go to previous page
	if (isPreviousRelatedKey(event)) {
		if (changeRequestStore.currentPage() > 1) {
			crActions.prevPage();
		}
		return true;
	}

	return true;
}
