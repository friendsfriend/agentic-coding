import type { Provider, ProviderType, RepoSearchResult } from "@devenv/types";
import type {
	AddRepositoryStep,
	ConnectProviderStep,
	FindRepoMode,
} from "@devenv/ui";
import { createSignal } from "solid-js";

export function createProviderStore() {
	const [providers, setProviders] = createSignal<Provider[]>([]);
	const [providersLoading, setProvidersLoading] = createSignal(false);
	const [providersError, setProvidersError] = createSignal("");
	const [showConnectProviderModal, setShowConnectProviderModal] =
		createSignal(false);
	const [connectProviderStep, setConnectProviderStep] =
		createSignal<ConnectProviderStep>("selectProvider");
	const [connectProviderType, setConnectProviderType] =
		createSignal<ProviderType | null>(null);
	const [connectProviderIndex, setConnectProviderIndex] = createSignal(0);
	const [connectProviderName, setConnectProviderName] = createSignal("");
	const [connectProviderUsername, setConnectProviderUsername] =
		createSignal("");
	const [connectProviderToken, setConnectProviderToken] = createSignal("");
	const [connectProviderError, setConnectProviderError] = createSignal<
		string | null
	>(null);
	const [connectProviderSuccess, setConnectProviderSuccess] = createSignal<
		string | null
	>(null);
	const [connectProviderEditMode, setConnectProviderEditMode] =
		createSignal(false);
	const [showAddRepositoryModal, setShowAddRepositoryModal] =
		createSignal(false);
	const [addRepositoryStep, setAddRepositoryStep] =
		createSignal<AddRepositoryStep>("selectProvider");
	const [addRepositoryProviders, setAddRepositoryProviders] = createSignal<
		Array<{ name: string; type: string }>
	>([]);
	const [
		addRepositorySelectedProviderIndex,
		setAddRepositorySelectedProviderIndex,
	] = createSignal(0);
	const [addRepositorySearchQuery, setAddRepositorySearchQuery] =
		createSignal("");
	const [addRepositorySearchResults, setAddRepositorySearchResults] =
		createSignal<RepoSearchResult[]>([]);
	const [
		addRepositorySelectedResultIndex,
		setAddRepositorySelectedResultIndex,
	] = createSignal(0);
	const [addRepositoryManualUrl, setAddRepositoryManualUrl] = createSignal("");
	const [addRepositoryFindRepoMode, setAddRepositoryFindRepoMode] =
		createSignal<FindRepoMode>("selectMode");
	const [addRepositoryFindRepoModeIndex, setAddRepositoryFindRepoModeIndex] =
		createSignal(0);
	const [addRepositoryName, setAddRepositoryName] = createSignal("");
	const [addRepositoryBranches, setAddRepositoryBranches] = createSignal<
		string[]
	>([]);
	const [
		addRepositorySelectedBranchIndex,
		setAddRepositorySelectedBranchIndex,
	] = createSignal(0);
	const [addRepositoryBranchFilter, setAddRepositoryBranchFilter] =
		createSignal("");
	const [addRepositoryLoading, setAddRepositoryLoading] = createSignal(false);
	const [addRepositoryError, setAddRepositoryError] = createSignal<
		string | null
	>(null);
	const [addRepositoryDestinationType, setAddRepositoryDestinationType] =
		createSignal<"APP" | "LIB">("APP");
	const [
		addRepositoryDestinationTypeIndex,
		setAddRepositoryDestinationTypeIndex,
	] = createSignal(0);
	const [selectedProviderIndex, setSelectedProviderIndex] = createSignal(0);

	return {
		providers,
		setProviders,
		providersLoading,
		setProvidersLoading,
		providersError,
		setProvidersError,
		showConnectProviderModal,
		setShowConnectProviderModal,
		connectProviderStep,
		setConnectProviderStep,
		connectProviderType,
		setConnectProviderType,
		connectProviderIndex,
		setConnectProviderIndex,
		connectProviderName,
		setConnectProviderName,
		connectProviderUsername,
		setConnectProviderUsername,
		connectProviderToken,
		setConnectProviderToken,
		connectProviderError,
		setConnectProviderError,
		connectProviderSuccess,
		setConnectProviderSuccess,
		connectProviderEditMode,
		setConnectProviderEditMode,
		showAddRepositoryModal,
		setShowAddRepositoryModal,
		addRepositoryStep,
		setAddRepositoryStep,
		addRepositoryProviders,
		setAddRepositoryProviders,
		addRepositorySelectedProviderIndex,
		setAddRepositorySelectedProviderIndex,
		addRepositorySearchQuery,
		setAddRepositorySearchQuery,
		addRepositorySearchResults,
		setAddRepositorySearchResults,
		addRepositorySelectedResultIndex,
		setAddRepositorySelectedResultIndex,
		addRepositoryManualUrl,
		setAddRepositoryManualUrl,
		addRepositoryFindRepoMode,
		setAddRepositoryFindRepoMode,
		addRepositoryFindRepoModeIndex,
		setAddRepositoryFindRepoModeIndex,
		addRepositoryName,
		setAddRepositoryName,
		addRepositoryBranches,
		setAddRepositoryBranches,
		addRepositorySelectedBranchIndex,
		setAddRepositorySelectedBranchIndex,
		addRepositoryBranchFilter,
		setAddRepositoryBranchFilter,
		addRepositoryLoading,
		setAddRepositoryLoading,
		addRepositoryError,
		setAddRepositoryError,
		addRepositoryDestinationType,
		setAddRepositoryDestinationType,
		addRepositoryDestinationTypeIndex,
		setAddRepositoryDestinationTypeIndex,
		selectedProviderIndex,
		setSelectedProviderIndex,
	};
}

export type ProviderStore = ReturnType<typeof createProviderStore>;
