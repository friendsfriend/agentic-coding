import { isNextRelatedKey, isPreviousRelatedKey } from "./horizontal-scroll";
import { isDownKey, isLeftKey, isRightKey, isUpKey } from "./nav-keys";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types";

export async function handleIssueListKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
	_ctx: KeyboardContext,
): Promise<boolean> {
	const { appStore, issueStore, changeRequestStore } = stores;
	const { issueActions } = actions;

	if (
		appStore.viewMode() !== "issues" &&
		appStore.viewMode() !== "changeRequestLinkedIssues"
	) {
		return false;
	}

	// CR linked issues sub-view
	if (appStore.viewMode() === "changeRequestLinkedIssues") {
		const linkedIssues = changeRequestStore.changeRequestLinkedIssues();
		const selectedIdx =
			changeRequestStore.selectedChangeRequestLinkedIssueIndex();

		if (isDownKey(event)) {
			changeRequestStore.setSelectedCrLinkedIssueIndex(
				Math.min(selectedIdx + 1, linkedIssues.length - 1),
			);
			return true;
		}
		if (isUpKey(event)) {
			changeRequestStore.setSelectedCrLinkedIssueIndex(
				Math.max(selectedIdx - 1, 0),
			);
			return true;
		}
		if (event.name === "g" && !event.ctrl) {
			changeRequestStore.setSelectedCrLinkedIssueIndex(0);
			return true;
		}
		if (
			(event.name === "G" || (event.name === "g" && event.shift)) &&
			!event.ctrl
		) {
			changeRequestStore.setSelectedCrLinkedIssueIndex(
				Math.max(0, linkedIssues.length - 1),
			);
			return true;
		}
		if (event.name === "return" || event.name === "enter") {
			const issue = linkedIssues[selectedIdx];
			if (issue) {
				void issueActions.showIssueDetail(issue);
			}
			return true;
		}
		if (event.name === "escape" || event.name === "q") {
			changeRequestStore.setSelectedCrLinkedIssueIndex(0);
			appStore.popView();
			return true;
		}
		return true;
	}

	// Issue list view mode
	if (appStore.viewMode() === "issues") {
		const issues = issueStore.issues();
		// Handle search mode
		if (issueStore.issueSearchMode()) {
			if (event.name === "escape") {
				issueStore.setIssueSearchMode(false);
				issueStore.setIssueSearchQuery("");
				issueStore.setIssueSearchTerm("");
				return true;
			}
			if (event.name === "return") {
				issueStore.setIssueSearchMode(false);
				issueStore.setIssueSearchTerm(issueStore.issueSearchQuery());
				void issueActions.loadAllIssues(1, issueStore.issueSearchQuery());
				return true;
			}
			if (event.name === "backspace") {
				issueStore.setIssueSearchQuery((prev) => prev.slice(0, -1));
				return true;
			}
			if (
				event.sequence &&
				event.sequence.length === 1 &&
				event.sequence.charCodeAt(0) >= 32
			) {
				const sequence = event.sequence;
				issueStore.setIssueSearchQuery((prev) => prev + sequence);
				return true;
			}
			return true;
		}

		if (issueStore.showIssueListFilterModal()) {
			const params = issueStore.issueListFilterParameters();
			const param = params[issueStore.issueListFilterParameterIndex()];
			const values = param?.values ?? [];
			if (event.name === "x") {
				issueStore.setIssueListFilters({ labels: [] });
				issueStore.setSelectedIssueIndex(0);
				void issueActions.loadAllIssues(
					1,
					issueStore.issueSearchTerm() || undefined,
				);
				return true;
			}
			if (isLeftKey(event)) {
				issueStore.setIssueListFilterFocusedPane("parameter");
				return true;
			}
			if (isRightKey(event)) {
				issueStore.setIssueListFilterFocusedPane("value");
				return true;
			}
			if (isDownKey(event)) {
				if (issueStore.issueListFilterFocusedPane() === "parameter") {
					issueStore.setIssueListFilterParameterIndex(
						Math.min(
							issueStore.issueListFilterParameterIndex() + 1,
							params.length - 1,
						),
					);
					issueStore.setIssueListFilterValueIndex(0);
				} else
					issueStore.setIssueListFilterValueIndex(
						Math.min(
							issueStore.issueListFilterValueIndex() + 1,
							values.length - 1,
						),
					);
				return true;
			}
			if (isUpKey(event)) {
				if (issueStore.issueListFilterFocusedPane() === "parameter") {
					issueStore.setIssueListFilterParameterIndex(
						Math.max(issueStore.issueListFilterParameterIndex() - 1, 0),
					);
					issueStore.setIssueListFilterValueIndex(0);
				} else
					issueStore.setIssueListFilterValueIndex(
						Math.max(issueStore.issueListFilterValueIndex() - 1, 0),
					);
				return true;
			}
			if (event.name === "space" || event.sequence === " ") {
				const value = values[issueStore.issueListFilterValueIndex()]?.value;
				if (param && value) {
					const filters = { ...issueStore.issueListFilters() };
					const current = filters[param.key] ?? [];
					filters[param.key] = current.includes(value)
						? current.filter((item) => item !== value)
						: [...current, value];
					issueStore.setIssueListFilters(filters);
					issueStore.setSelectedIssueIndex(0);
					void issueActions.loadAllIssues(
						1,
						issueStore.issueSearchTerm() || undefined,
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
				issueStore.setShowIssueListFilterModal(false);
				return true;
			}
			return true;
		}

		if (issueStore.showIssueListSortModal()) {
			const rules = issueStore.issueListSortRules();
			const idx = issueStore.issueListSortSelectedIndex();
			const cycle = (d: "asc" | "desc" | "none") =>
				d === "none" ? "asc" : d === "asc" ? "desc" : "none";
			if (event.name === "x") {
				issueStore.setIssueListSortRules(
					rules.map((rule) => ({ ...rule, direction: "none" })),
				);
				void issueActions.loadAllIssues(
					1,
					issueStore.issueSearchTerm() || undefined,
				);
				return true;
			}
			if (isDownKey(event)) {
				issueStore.setIssueListSortSelectedIndex(
					Math.min(idx + 1, rules.length - 1),
				);
				return true;
			}
			if (isUpKey(event)) {
				issueStore.setIssueListSortSelectedIndex(Math.max(idx - 1, 0));
				return true;
			}
			if (event.name === "space" || event.sequence === " ") {
				issueStore.setIssueListSortRules(
					rules.map((rule, i) =>
						i === idx ? { ...rule, direction: cycle(rule.direction) } : rule,
					),
				);
				void issueActions.loadAllIssues(
					1,
					issueStore.issueSearchTerm() || undefined,
				);
				return true;
			}
			if (
				event.name === "enter" ||
				event.name === "return" ||
				event.name === "escape" ||
				event.name === "q"
			) {
				issueStore.setShowIssueListSortModal(false);
				return true;
			}
			return true;
		}

		if (event.name === "F" || (event.name === "f" && event.shift)) {
			issueStore.setShowIssueListFilterModal(true);
			return true;
		}
		if (event.name === "O" || (event.name === "o" && event.shift)) {
			issueStore.setShowIssueListSortModal(true);
			return true;
		}

		// Navigation
		if (isDownKey(event)) {
			const nextIdx = Math.min(
				issueStore.selectedIssueIndex() + 1,
				issues.length - 1,
			);
			issueStore.setSelectedIssueIndex(Math.max(0, nextIdx));
			return true;
		}
		if (isUpKey(event)) {
			const nextIdx = Math.max(issueStore.selectedIssueIndex() - 1, 0);
			issueStore.setSelectedIssueIndex(nextIdx);
			return true;
		}
		if (event.name === "g" && !event.ctrl) {
			issueStore.setSelectedIssueIndex(0);
			return true;
		}
		if (
			(event.name === "G" || (event.name === "g" && event.shift)) &&
			!event.ctrl
		) {
			issueStore.setSelectedIssueIndex(Math.max(0, issues.length - 1));
			return true;
		}
		if (event.name === "return") {
			const issue = issues[issueStore.selectedIssueIndex()];
			if (issue) {
				void issueActions.showIssueDetail(issue);
			}
			return true;
		}
		if (event.name === "escape") {
			if (issueStore.issueSearchQuery() || issueStore.issueSearchTerm()) {
				issueStore.setIssueSearchMode(false);
				issueStore.setIssueSearchQuery("");
				issueStore.setIssueSearchTerm("");
				issueStore.setSelectedIssueIndex(0);
				void issueActions.loadAllIssues(1);
				return true;
			}
			issueActions.abortViewLoads();
			appStore.popView();
			issueStore.setIssues([]);
			issueStore.setIssueError("");
			return true;
		}
		if (event.name === "q") {
			issueActions.abortViewLoads();
			appStore.popView();
			issueStore.setIssues([]);
			issueStore.setIssueError("");
			return true;
		}
		// s cycles state filter: open → closed → all → open
		if (event.name === "s" && !event.shift && !event.ctrl) {
			const current = issueStore.issueListFilters().state?.[0] ?? "open";
			const next =
				current === "open" ? "closed" : current === "closed" ? "all" : "open";
			issueStore.setIssueListFilters({
				...issueStore.issueListFilters(),
				state: next === "all" ? [] : [next],
			});
			void issueActions.loadAllIssues();
			return true;
		}

		// Search
		if (event.name === "/" || event.sequence === "/") {
			issueStore.setIssueSearchMode(true);
			issueStore.setIssueSearchQuery("");
			return true;
		}
		// Pagination
		if (isNextRelatedKey(event)) {
			void issueActions.nextPage();
			return true;
		}
		if (isPreviousRelatedKey(event)) {
			void issueActions.prevPage();
			return true;
		}
		// For keys that should fall through to the table handler
		if (event.name === "i" || event.name === "I") {
			return false;
		}
		return true;
	}

	return false;
}
