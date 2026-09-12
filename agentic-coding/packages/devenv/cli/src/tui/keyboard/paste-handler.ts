import type { PasteEvent } from "@opentui/core";
import type { ProviderStore } from "../stores";

export function routePastedText(
	text: string,
	providerStore: ProviderStore,
): boolean {
	if (!text) return false;

	/**
	 * Handles paste events for the TUI — routes pasted text to the appropriate
	 * input field based on current modal state.
	 */
	if (providerStore.showAddRepositoryModal()) {
		const step = providerStore.addRepositoryStep();
		const mode = providerStore.addRepositoryFindRepoMode();
		if (step === "findRepo" && mode === "url") {
			providerStore.setAddRepositoryManualUrl((v) => v + text);
		} else if (step === "findRepo" && mode === "search") {
			providerStore.setAddRepositorySearchQuery((v) => v + text);
		} else if (step === "repositoryName") {
			providerStore.setAddRepositoryName((v) => v + text);
		} else if (step === "selectBranch") {
			providerStore.setAddRepositoryBranchFilter((v) => v + text);
			providerStore.setAddRepositorySelectedBranchIndex(0);
		}
		return true;
	}

	if (providerStore.showConnectProviderModal()) {
		const step = providerStore.connectProviderStep();
		if (step === "name") providerStore.setConnectProviderName((v) => v + text);
		else if (step === "username")
			providerStore.setConnectProviderUsername((v) => v + text);
		else if (step === "token")
			providerStore.setConnectProviderToken((v) => v + text);
		return true;
	}

	return false;
}

export function handlePaste(
	event: PasteEvent,
	providerStore: ProviderStore,
): void {
	const text = new TextDecoder().decode(event.bytes);
	routePastedText(text, providerStore);
}
