import { isDownKey, isLeftKey, isRightKey, isUpKey } from "./nav-keys";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types";

/**
 * Handles keyboard events for the combined References sub-view:
 * - j/k navigation, Enter opens selected item (issue detail or CR detail)
 * - F opens filter, O opens sort/order
 * - ESC/q returns to issue detail
 */
export async function handleReferencesKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
	_ctx: KeyboardContext,
): Promise<boolean> {
	const { appStore, issueStore } = stores;
	const { issueActions } = actions;

	if (appStore.viewMode() !== "references") {
		return false;
	}

	const cycleDirection = (direction: "asc" | "desc" | "none") => {
		if (direction === "none") return "asc";
		if (direction === "asc") return "desc";
		return "none";
	};

	if (issueStore.showReferenceFilterModal()) {
		const params = issueStore.referenceFilterParameters();
		const param = params[issueStore.referenceFilterParameterIndex()];
		const values = param?.values ?? [];
		if (event.name === "x") {
			issueStore.setReferenceFilters({ type: [], state: [] });
			issueStore.setSelectedReferenceIndex(0);
			return true;
		}
		if (isLeftKey(event)) {
			issueStore.setReferenceFilterFocusedPane("parameter");
			return true;
		}
		if (isRightKey(event)) {
			issueStore.setReferenceFilterFocusedPane("value");
			return true;
		}
		if (isDownKey(event)) {
			if (issueStore.referenceFilterFocusedPane() === "parameter") {
				issueStore.setReferenceFilterParameterIndex(
					Math.min(
						issueStore.referenceFilterParameterIndex() + 1,
						params.length - 1,
					),
				);
				issueStore.setReferenceFilterValueIndex(0);
			} else {
				issueStore.setReferenceFilterValueIndex(
					Math.min(
						issueStore.referenceFilterValueIndex() + 1,
						values.length - 1,
					),
				);
			}
			return true;
		}
		if (isUpKey(event)) {
			if (issueStore.referenceFilterFocusedPane() === "parameter") {
				issueStore.setReferenceFilterParameterIndex(
					Math.max(issueStore.referenceFilterParameterIndex() - 1, 0),
				);
				issueStore.setReferenceFilterValueIndex(0);
			} else {
				issueStore.setReferenceFilterValueIndex(
					Math.max(issueStore.referenceFilterValueIndex() - 1, 0),
				);
			}
			return true;
		}
		if (event.name === "space" || event.sequence === " ") {
			const value = values[issueStore.referenceFilterValueIndex()]?.value;
			if (param && value) {
				const filters = { ...issueStore.referenceFilters() };
				const current = filters[param.key as "type" | "state"] ?? [];
				filters[param.key as "type" | "state"] = current.includes(value)
					? current.filter((item) => item !== value)
					: [...current, value];
				issueStore.setReferenceFilters(filters);
				issueStore.setSelectedReferenceIndex(0);
			}
			return true;
		}
		if (
			event.name === "enter" ||
			event.name === "return" ||
			event.name === "escape" ||
			event.name === "q"
		) {
			issueStore.setShowReferenceFilterModal(false);
			return true;
		}
		return true;
	}

	if (issueStore.showReferenceSortModal()) {
		const rules = issueStore.referenceSortRules();
		const idx = issueStore.referenceSortSelectedIndex();
		if (event.name === "x") {
			issueStore.setReferenceSortRules(
				rules.map((rule) => ({ ...rule, direction: "none" })),
			);
			issueStore.setSelectedReferenceIndex(0);
			return true;
		}
		if (isDownKey(event)) {
			issueStore.setReferenceSortSelectedIndex(
				Math.min(idx + 1, rules.length - 1),
			);
			return true;
		}
		if (isUpKey(event)) {
			issueStore.setReferenceSortSelectedIndex(Math.max(idx - 1, 0));
			return true;
		}
		if (event.name === "space" || event.sequence === " ") {
			issueStore.setReferenceSortRules(
				rules.map((rule, ruleIndex) =>
					ruleIndex === idx
						? { ...rule, direction: cycleDirection(rule.direction) }
						: rule,
				),
			);
			issueStore.setSelectedReferenceIndex(0);
			return true;
		}
		if (
			(event.name === "K" || (event.name === "k" && event.shift)) &&
			idx > 0
		) {
			const next = [...rules];
			[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
			issueStore.setReferenceSortRules(next);
			issueStore.setReferenceSortSelectedIndex(idx - 1);
			return true;
		}
		if (
			(event.name === "J" || (event.name === "j" && event.shift)) &&
			idx < rules.length - 1
		) {
			const next = [...rules];
			[next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
			issueStore.setReferenceSortRules(next);
			issueStore.setReferenceSortSelectedIndex(idx + 1);
			return true;
		}
		if (
			event.name === "enter" ||
			event.name === "return" ||
			event.name === "escape" ||
			event.name === "q"
		) {
			issueStore.setShowReferenceSortModal(false);
			return true;
		}
		return true;
	}

	const refs = issueStore.referencesFiltered();
	const idx = issueStore.selectedReferenceIndex();

	if (event.name === "F" || (event.name === "f" && event.shift)) {
		issueStore.setShowReferenceFilterModal(true);
		return true;
	}

	if (event.name === "O" || (event.name === "o" && event.shift)) {
		issueStore.setShowReferenceSortModal(true);
		return true;
	}

	if (isDownKey(event)) {
		issueStore.setSelectedReferenceIndex(Math.min(idx + 1, refs.length - 1));
		return true;
	}

	if (isUpKey(event)) {
		issueStore.setSelectedReferenceIndex(Math.max(idx - 1, 0));
		return true;
	}

	if (event.name === "g" && !event.ctrl) {
		issueStore.setSelectedReferenceIndex(0);
		return true;
	}

	if (
		(event.name === "G" || (event.name === "g" && event.shift)) &&
		!event.ctrl
	) {
		issueStore.setSelectedReferenceIndex(Math.max(0, refs.length - 1));
		return true;
	}

	if (event.name === "return" || event.name === "enter") {
		const ref = refs[idx];
		if (!ref) return true;

		if (ref.type === "issue") {
			void issueActions.showIssueDetail(ref.data);
		} else if (ref.type === "cr") {
			actions.crActions?.showCRDetail(ref.data);
		}
		return true;
	}

	if (event.name === "escape" || event.name === "q") {
		issueStore.setShowReferenceFilterModal(false);
		issueStore.setShowReferenceSortModal(false);
		issueActions.backToIssueDetailFromReferences();
		return true;
	}

	return true;
}
