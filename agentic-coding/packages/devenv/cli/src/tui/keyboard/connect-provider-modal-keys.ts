import type { ProviderType } from "@devenv/types";
import { isDownKey, isUpKey } from "./nav-keys";
import type { KeyboardActions, KeyboardEvent, KeyboardStores } from "./types";
/**
 * Handles keyboard events for the Connect Provider modal:
 * selectProvider → name → username → token → save
 */
export function handleConnectProviderModalKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
): boolean {
	const { providerStore } = stores;
	const { providerActions } = actions;

	if (!providerStore.showConnectProviderModal()) return false;

	const step = providerStore.connectProviderStep();

	if (
		event.name === "escape" ||
		event.name === "Escape" ||
		event.name === "esc"
	) {
		if (step === "selectProvider") {
			providerActions.resetConnectProviderModal();
		} else if (step === "name") {
			providerStore.setConnectProviderStep("selectProvider");
			providerStore.setConnectProviderError(null);
		} else if (step === "username") {
			if (providerStore.connectProviderEditMode()) {
				providerActions.resetConnectProviderModal();
			} else {
				providerStore.setConnectProviderStep("name");
				providerStore.setConnectProviderError(null);
			}
		} else if (step === "token") {
			providerStore.setConnectProviderStep("username");
			providerStore.setConnectProviderError(null);
		}
		return true;
	}

	if (step === "selectProvider") {
		if (isDownKey(event)) {
			providerStore.setConnectProviderIndex((i) => (i + 1) % 2);
			return true;
		}
		if (isUpKey(event)) {
			providerStore.setConnectProviderIndex((i) => (i - 1 + 2) % 2);
			return true;
		}
		if (
			event.name === "return" ||
			event.name === "enter" ||
			event.name === "Return" ||
			event.name === "Enter"
		) {
			const types: Array<ProviderType> = ["github", "gitlab"];
			providerStore.setConnectProviderType(
				types[providerStore.connectProviderIndex()],
			);
			providerStore.setConnectProviderStep("name");
			return true;
		}
		return true;
	}

	if (
		event.name === "return" ||
		event.name === "enter" ||
		event.name === "Return" ||
		event.name === "Enter"
	) {
		if (step === "name") {
			if (!providerStore.connectProviderName().trim()) {
				providerStore.setConnectProviderError("Name is required");
				return true;
			}
			providerStore.setConnectProviderError(null);
			providerStore.setConnectProviderStep("username");
		} else if (step === "username") {
			providerStore.setConnectProviderError(null);
			providerStore.setConnectProviderStep("token");
		} else if (step === "token") {
			void providerActions.saveProvider();
		}
		return true;
	}

	if (event.name === "backspace" || event.name === "delete") {
		if (step === "name")
			providerStore.setConnectProviderName((v) => v.slice(0, -1));
		else if (step === "username")
			providerStore.setConnectProviderUsername((v) => v.slice(0, -1));
		else if (step === "token")
			providerStore.setConnectProviderToken((v) => v.slice(0, -1));
		return true;
	}

	const ch = event.sequence ?? event.name ?? "";
	if (ch.length === 1 && ch >= " ") {
		if (step === "name") providerStore.setConnectProviderName((v) => v + ch);
		else if (step === "username")
			providerStore.setConnectProviderUsername((v) => v + ch);
		else if (step === "token")
			providerStore.setConnectProviderToken((v) => v + ch);
		return true;
	}

	return true;
}
