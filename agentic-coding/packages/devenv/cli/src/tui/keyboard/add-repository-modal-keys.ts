import { isDownKey, isUpKey } from "./nav-keys";
import type { KeyboardActions, KeyboardEvent, KeyboardStores } from "./types";
/**
 * Handles keyboard events for the Add Repository modal wizard flow:
 * selectProvider → selectDestination → findRepo → repositoryName → selectBranch → confirm
 */
export function handleAddRepositoryModalKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
): boolean {
	const { providerStore } = stores;
	const { providerActions } = actions;

	if (!providerStore.showAddRepositoryModal()) return false;

	const step = providerStore.addRepositoryStep();

	if (
		event.name === "escape" ||
		event.name === "Escape" ||
		event.name === "esc"
	) {
		providerActions.abortRepositorySearch();
		if (step === "selectProvider") {
			providerActions.resetAddRepositoryModal();
		} else if (step === "selectDestination") {
			providerStore.setAddRepositoryStep("selectProvider");
			providerStore.setAddRepositoryError(null);
		} else if (step === "findRepo") {
			const mode = providerStore.addRepositoryFindRepoMode();
			if (mode === "selectMode") {
				providerStore.setAddRepositoryStep("selectDestination");
			} else {
				providerStore.setAddRepositoryFindRepoMode("selectMode");
			}
			providerStore.setAddRepositoryError(null);
		} else if (step === "repositoryName") {
			providerStore.setAddRepositoryStep("findRepo");
			providerStore.setAddRepositoryError(null);
		} else if (step === "selectBranch") {
			providerStore.setAddRepositoryStep("repositoryName");
			providerStore.setAddRepositoryError(null);
		} else if (step === "confirm") {
			providerStore.setAddRepositoryStep("selectBranch");
			providerStore.setAddRepositoryError(null);
		}
		return true;
	}

	if (step === "selectProvider") {
		const providers = providerStore.addRepositoryProviders();
		if (isDownKey(event)) {
			providerStore.setAddRepositorySelectedProviderIndex(
				(i) => (i + 1) % Math.max(1, providers.length),
			);
			return true;
		}
		if (isUpKey(event)) {
			providerStore.setAddRepositorySelectedProviderIndex(
				(i) => (i - 1 + providers.length) % Math.max(1, providers.length),
			);
			return true;
		}
		if (
			event.name === "return" ||
			event.name === "enter" ||
			event.name === "Return" ||
			event.name === "Enter"
		) {
			if (providers.length > 0) {
				providerStore.setAddRepositorySearchQuery("");
				providerStore.setAddRepositorySearchResults([]);
				providerStore.setAddRepositorySelectedResultIndex(0);
				providerStore.setAddRepositoryManualUrl("");
				providerStore.setAddRepositoryFindRepoMode("selectMode");
				providerStore.setAddRepositoryFindRepoModeIndex(0);
				providerStore.setAddRepositoryName("");
				providerStore.setAddRepositoryBranches([]);
				providerStore.setAddRepositorySelectedBranchIndex(0);
				providerStore.setAddRepositoryBranchFilter("");
				providerStore.setAddRepositoryStep("selectDestination");
				providerStore.setAddRepositoryError(null);
			}
			return true;
		}
		return true;
	}

	if (step === "selectDestination") {
		if (isDownKey(event)) {
			providerStore.setAddRepositoryDestinationTypeIndex((i) => (i + 1) % 2);
			return true;
		}
		if (isUpKey(event)) {
			providerStore.setAddRepositoryDestinationTypeIndex(
				(i) => (i - 1 + 2) % 2,
			);
			return true;
		}
		if (
			event.name === "return" ||
			event.name === "enter" ||
			event.name === "Return" ||
			event.name === "Enter"
		) {
			providerStore.setAddRepositoryDestinationType(
				providerStore.addRepositoryDestinationTypeIndex() === 0 ? "APP" : "LIB",
			);
			providerStore.setAddRepositoryStep("findRepo");
			providerStore.setAddRepositoryError(null);
			return true;
		}
		return true;
	}

	if (step === "findRepo") {
		const mode = providerStore.addRepositoryFindRepoMode();
		if (mode === "selectMode") {
			if (isDownKey(event)) {
				providerStore.setAddRepositoryFindRepoModeIndex((i) => (i + 1) % 2);
				return true;
			}
			if (isUpKey(event)) {
				providerStore.setAddRepositoryFindRepoModeIndex((i) => (i - 1 + 2) % 2);
				return true;
			}
			if (
				event.name === "return" ||
				event.name === "enter" ||
				event.name === "Return" ||
				event.name === "Enter"
			) {
				providerStore.setAddRepositoryFindRepoMode(
					providerStore.addRepositoryFindRepoModeIndex() === 0
						? "search"
						: "url",
				);
				providerStore.setAddRepositoryError(null);
				return true;
			}
		} else if (mode === "url") {
			if (
				event.name === "return" ||
				event.name === "enter" ||
				event.name === "Return" ||
				event.name === "Enter"
			) {
				if (providerStore.addRepositoryManualUrl().trim()) {
					const url = providerStore.addRepositoryManualUrl().trim();
					const repoName =
						url
							.split("/")
							.pop()
							?.replace(/\.git$/, "") ?? "";
					providerStore.setAddRepositoryName(repoName);
					providerStore.setAddRepositoryStep("repositoryName");
					providerStore.setAddRepositoryError(null);
				} else {
					providerStore.setAddRepositoryError("URL is required");
				}
				return true;
			}
			if (event.name === "backspace" || event.name === "delete") {
				providerStore.setAddRepositoryManualUrl((v) => v.slice(0, -1));
				return true;
			}
			const ch = event.sequence ?? event.name ?? "";
			if (ch.length === 1 && ch >= " ") {
				providerStore.setAddRepositoryManualUrl((v) => v + ch);
				return true;
			}
		} else {
			// search mode
			if (
				event.name === "return" ||
				event.name === "enter" ||
				event.name === "Return" ||
				event.name === "Enter"
			) {
				const results = providerStore.addRepositorySearchResults();
				if (results.length > 0) {
					const selected =
						results[providerStore.addRepositorySelectedResultIndex()];
					if (selected) {
						providerStore.setAddRepositoryName(selected.name);
						providerStore.setAddRepositoryStep("repositoryName");
						providerStore.setAddRepositoryError(null);
					}
				} else if (providerStore.addRepositorySearchQuery().trim()) {
					void providerActions.addRepositoryPerformSearch();
				}
				return true;
			}
			if (isDownKey(event)) {
				const results = providerStore.addRepositorySearchResults();
				if (results.length > 0) {
					providerStore.setAddRepositorySelectedResultIndex(
						(i) => (i + 1) % results.length,
					);
				}
				return true;
			}
			if (isUpKey(event)) {
				const results = providerStore.addRepositorySearchResults();
				if (results.length > 0) {
					providerStore.setAddRepositorySelectedResultIndex(
						(i) => (i - 1 + results.length) % results.length,
					);
				}
				return true;
			}
			if (event.name === "backspace" || event.name === "delete") {
				providerStore.setAddRepositorySearchQuery((v) => v.slice(0, -1));
				return true;
			}
			const ch = event.sequence ?? event.name ?? "";
			if (ch.length === 1 && ch >= " ") {
				providerStore.setAddRepositorySearchQuery((v) => v + ch);
				return true;
			}
		}
		return true;
	}

	if (step === "repositoryName") {
		if (
			event.name === "return" ||
			event.name === "enter" ||
			event.name === "Return" ||
			event.name === "Enter"
		) {
			if (providerStore.addRepositoryName().trim()) {
				providerStore.setAddRepositoryError(null);
				const repoUrl =
					providerStore.addRepositoryFindRepoMode() === "url"
						? providerStore.addRepositoryManualUrl().trim()
						: (providerStore.addRepositorySearchResults()[
								providerStore.addRepositorySelectedResultIndex()
							]?.url ?? "");
				if (repoUrl) {
					void providerActions.addRepositoryFetchBranches(repoUrl);
					providerStore.setAddRepositoryStep("selectBranch");
				} else {
					providerStore.setAddRepositoryError("No repository URL");
				}
			} else {
				providerStore.setAddRepositoryError("Repository name is required");
			}
			return true;
		}
		if (event.name === "backspace" || event.name === "delete") {
			providerStore.setAddRepositoryName((v) => v.slice(0, -1));
			return true;
		}
		const ch = event.sequence ?? event.name ?? "";
		if (ch.length === 1 && ch >= " ") {
			providerStore.setAddRepositoryName((v) => v + ch);
			return true;
		}
		return true;
	}

	if (step === "selectBranch") {
		const filteredBranchList = providerStore
			.addRepositoryBranches()
			.filter((b) =>
				b
					.toLowerCase()
					.includes(providerStore.addRepositoryBranchFilter().toLowerCase()),
			);
		if (
			event.name === "return" ||
			event.name === "enter" ||
			event.name === "Return" ||
			event.name === "Enter"
		) {
			if (filteredBranchList.length > 0) {
				providerStore.setAddRepositoryStep("confirm");
				providerStore.setAddRepositoryError(null);
			}
			return true;
		}
		if (isDownKey(event)) {
			if (filteredBranchList.length > 0) {
				providerStore.setAddRepositorySelectedBranchIndex(
					(i) => (i + 1) % filteredBranchList.length,
				);
			}
			return true;
		}
		if (isUpKey(event)) {
			if (filteredBranchList.length > 0) {
				providerStore.setAddRepositorySelectedBranchIndex(
					(i) =>
						(i - 1 + filteredBranchList.length) % filteredBranchList.length,
				);
			}
			return true;
		}
		if (event.name === "backspace" || event.name === "delete") {
			providerStore.setAddRepositoryBranchFilter((v) => v.slice(0, -1));
			providerStore.setAddRepositorySelectedBranchIndex(0);
			return true;
		}
		const ch = event.sequence ?? event.name ?? "";
		if (ch.length === 1 && ch >= " ") {
			providerStore.setAddRepositoryBranchFilter((v) => v + ch);
			providerStore.setAddRepositorySelectedBranchIndex(0);
			return true;
		}
		return true;
	}

	if (step === "confirm") {
		if (
			event.name === "return" ||
			event.name === "enter" ||
			event.name === "Return" ||
			event.name === "Enter"
		) {
			void providerActions.addRepositorySubmitCreate();
			return true;
		}
		return true;
	}

	return true;
}
