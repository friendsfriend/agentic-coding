import type { DevEnvClient } from "@devenv/core";
import type { CreateAppRequest } from "@devenv/types";
import type { AppStore } from "../stores/app-store";
import type { ProviderStore } from "../stores/provider-store";
import type { NotificationType } from "../stores/ui-store";

export function createProviderActions(
	appStore: AppStore,
	providerStore: ProviderStore,
	client: DevEnvClient,
	showError: (title: string, message: string) => void,
	uiStore?: {
		setNotification: (message: string, type: NotificationType) => void;
	},
) {
	let repoSearchAbortController: AbortController | null = null;
	const abortRepositorySearch = () => {
		repoSearchAbortController?.abort();
		repoSearchAbortController = null;
	};

	const refreshProviders = async () => {
		providerStore.setProvidersLoading(true);
		providerStore.setProvidersError("");
		try {
			const providers = await client.getProviders();
			providerStore.setProviders(providers);
			if (uiStore) {
				for (const p of providers) {
					if (p.missing_vars && p.missing_vars.length > 0) {
						uiStore.setNotification(
							`Missing env vars for ${p.name}: ${p.missing_vars.join(", ")}`,
							"warning",
						);
					}
				}
			}
		} catch (e) {
			providerStore.setProvidersError(
				e instanceof Error ? e.message : "Unknown error",
			);
			providerStore.setProviders([]);
		} finally {
			providerStore.setProvidersLoading(false);
		}
	};

	const loadProviders = async () => {
		if (appStore.operationInProgressForApp())
			return showError(
				"Operation In Progress",
				"Another operation is already in progress. Please wait for it to complete.",
			);
		appStore.pushView("providers");
		await refreshProviders();
	};

	const resetConnectProviderModal = () => {
		providerStore.setShowConnectProviderModal(false);
		providerStore.setConnectProviderStep("selectProvider");
		providerStore.setConnectProviderType(null);
		providerStore.setConnectProviderIndex(0);
		providerStore.setConnectProviderName("");
		providerStore.setConnectProviderUsername("");
		providerStore.setConnectProviderToken("");
		providerStore.setConnectProviderError(null);
		providerStore.setConnectProviderSuccess(null);
		providerStore.setConnectProviderEditMode(false);
	};

	const resetAddRepositoryModal = () => {
		abortRepositorySearch();
		providerStore.setShowAddRepositoryModal(false);
		providerStore.setAddRepositoryStep("selectProvider");
		providerStore.setAddRepositoryProviders([]);
		providerStore.setAddRepositorySelectedProviderIndex(0);
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
		providerStore.setAddRepositoryLoading(false);
		providerStore.setAddRepositoryError(null);
		providerStore.setAddRepositoryDestinationType("APP");
		providerStore.setAddRepositoryDestinationTypeIndex(0);
	};

	const openAddRepositoryModal = async () => {
		resetAddRepositoryModal();
		const tab = appStore.activeTab();
		providerStore.setAddRepositoryDestinationTypeIndex(
			tab === "libraries" ? 1 : 0,
		);
		providerStore.setAddRepositoryDestinationType(
			tab === "libraries" ? "LIB" : "APP",
		);
		providerStore.setAddRepositoryLoading(true);
		providerStore.setShowAddRepositoryModal(true);
		try {
			const providers = await client.getProviders();
			const usableProviders = providers.filter((p) => !p.invalid);
			providerStore.setAddRepositoryProviders(
				usableProviders.map((p) => ({ name: p.name, type: p.type })),
			);
			if (usableProviders.length === 0) {
				providerStore.setAddRepositoryError(
					providers.length === 0
						? "No providers configured. Add a provider first."
						: "All providers are invalid. Open providers view and move clear-text credentials to .env placeholders.",
				);
			}
		} catch (e) {
			providerStore.setAddRepositoryError(
				e instanceof Error ? e.message : "Failed to load providers",
			);
		} finally {
			providerStore.setAddRepositoryLoading(false);
		}
	};

	const addRepositoryPerformSearch = async () => {
		const query = providerStore.addRepositorySearchQuery().trim();
		if (!query) return;
		const providers = providerStore.addRepositoryProviders();
		const idx = providerStore.addRepositorySelectedProviderIndex();
		if (idx < 0 || idx >= providers.length) return;
		const provider = providers[idx];
		abortRepositorySearch();
		const controller = new AbortController();
		repoSearchAbortController = controller;
		providerStore.setAddRepositoryLoading(true);
		providerStore.setAddRepositoryError(null);
		try {
			const results = await client.searchRepos(
				provider.name,
				query,
				undefined,
				controller.signal,
			);
			providerStore.setAddRepositorySearchResults(results);
			providerStore.setAddRepositorySelectedResultIndex(0);
			if (!results.length)
				providerStore.setAddRepositoryError("No repositories found");
		} catch (e) {
			if (!(e instanceof DOMException && e.name === "AbortError")) {
				providerStore.setAddRepositoryError(
					e instanceof Error ? e.message : "Search failed",
				);
			}
		} finally {
			if (repoSearchAbortController === controller)
				repoSearchAbortController = null;
			if (!controller.signal.aborted)
				providerStore.setAddRepositoryLoading(false);
		}
	};

	const addRepositoryFetchBranches = async (repoUrl: string) => {
		providerStore.setAddRepositoryLoading(true);
		providerStore.setAddRepositoryError(null);
		try {
			const branches = await client.getRepoBranches(repoUrl);
			providerStore.setAddRepositoryBranches(branches);
			providerStore.setAddRepositorySelectedBranchIndex(0);
			if (!branches.length)
				providerStore.setAddRepositoryError("No branches found");
		} catch (e) {
			providerStore.setAddRepositoryError(
				e instanceof Error ? e.message : "Failed to load branches",
			);
		} finally {
			providerStore.setAddRepositoryLoading(false);
		}
	};

	const addRepositorySubmitCreate = async () => {
		const providers = providerStore.addRepositoryProviders();
		const providerIdx = providerStore.addRepositorySelectedProviderIndex();
		if (providerIdx < 0 || providerIdx >= providers.length) return;
		const repoUrl =
			providerStore.addRepositoryFindRepoMode() === "url"
				? providerStore.addRepositoryManualUrl().trim()
				: (providerStore.addRepositorySearchResults()[
						providerStore.addRepositorySelectedResultIndex()
					]?.url ?? "");
		const filteredBranchList = providerStore
			.addRepositoryBranches()
			.filter((b) =>
				b
					.toLowerCase()
					.includes(providerStore.addRepositoryBranchFilter().toLowerCase()),
			);
		const branch =
			filteredBranchList[providerStore.addRepositorySelectedBranchIndex()] ??
			"";
		if (!providerStore.addRepositoryName().trim() || !repoUrl || !branch) {
			providerStore.setAddRepositoryError("Missing required fields");
			return;
		}
		providerStore.setAddRepositoryLoading(true);
		providerStore.setAddRepositoryError(null);
		try {
			const request: CreateAppRequest = {
				displayName: providerStore.addRepositoryName().trim(),
				repositoryURL: repoUrl,
				branch,
				provider: providers[providerIdx].name,
				definitionLocation:
					providerStore.addRepositoryDestinationType() === "LIB"
						? "libraries"
						: "apps",
			};
			const newApp = await client.createApp(request);
			resetAddRepositoryModal();
			appStore.setApps((prev) => [
				...prev,
				{
					...newApp,
					operationStatus: {
						operation: "checkout",
						status: "active",
						message: "Checking out...",
					},
				},
			]);
			const fetchedApps = await client.getApps();
			appStore.setApps((prev) => {
				const statusMap = new Map<
					string,
					NonNullable<(typeof prev)[number]["operationStatus"]>
				>();
				for (const a of prev) {
					if (a.operationStatus) statusMap.set(a.ident, a.operationStatus);
				}
				return fetchedApps.map((a) =>
					statusMap.has(a.ident)
						? { ...a, operationStatus: statusMap.get(a.ident) }
						: a,
				);
			});
		} catch (e) {
			providerStore.setAddRepositoryError(
				e instanceof Error ? e.message : "Failed to create repository entry",
			);
			providerStore.setAddRepositoryLoading(false);
		}
	};

	const openAddProviderModal = () => {
		resetConnectProviderModal();
		providerStore.setShowConnectProviderModal(true);
	};

	const openEditProviderModal = () => {
		const list = providerStore.providers();
		const idx = providerStore.selectedProviderIndex();
		if (idx < 0 || idx >= list.length) return;
		const provider = list[idx];
		if (!provider) return;
		if (provider.type !== "github" && provider.type !== "gitlab") {
			showError(
				"Cannot Edit Provider",
				"Provider type is missing or invalid. Delete and recreate this provider.",
			);
			return;
		}
		resetConnectProviderModal();
		providerStore.setConnectProviderEditMode(true);
		providerStore.setConnectProviderType(provider.type);
		providerStore.setConnectProviderName(provider.name);
		providerStore.setConnectProviderUsername(provider.username);
		providerStore.setConnectProviderStep("username");
		providerStore.setShowConnectProviderModal(true);
	};

	const deleteSelectedProvider = async () => {
		const list = providerStore.providers();
		const idx = providerStore.selectedProviderIndex();
		if (idx < 0 || idx >= list.length) return;
		const provider = list[idx];
		if (!provider) return;
		try {
			await client.deleteProvider(provider.name);
			const fetched = await client.getProviders();
			providerStore.setProviders(fetched);
			if (providerStore.selectedProviderIndex() >= fetched.length)
				providerStore.setSelectedProviderIndex(Math.max(0, fetched.length - 1));
		} catch (e) {
			showError(
				"Delete Provider Failed",
				e instanceof Error ? e.message : "Unknown error",
			);
		}
	};

	const saveProvider = async () => {
		const providerType = providerStore.connectProviderType();
		const name = providerStore.connectProviderName().trim();
		const username = providerStore.connectProviderUsername().trim();
		const token = providerStore.connectProviderToken();
		if (!providerType || !name) {
			providerStore.setConnectProviderError(
				"Provider type and name are required",
			);
			return;
		}
		try {
			if (providerStore.connectProviderEditMode()) {
				const updates: Record<string, string> = { username };
				if (token) updates.token = token;
				await client.updateProvider(name, updates);
			} else {
				await client.createProvider({
					name,
					type: providerType,
					username,
					token,
				});
			}
			providerStore.setConnectProviderSuccess(
				providerStore.connectProviderEditMode()
					? "Provider updated!"
					: "Provider created!",
			);
			providerStore.setProviders(await client.getProviders());
			setTimeout(() => resetConnectProviderModal(), 800);
		} catch (e) {
			providerStore.setConnectProviderError(
				e instanceof Error ? e.message : "Failed to save provider",
			);
		}
	};

	return {
		loadProviders,
		refreshProviders,
		resetConnectProviderModal,
		resetAddRepositoryModal,
		openAddRepositoryModal,
		addRepositoryPerformSearch,
		abortRepositorySearch,
		addRepositoryFetchBranches,
		addRepositorySubmitCreate,
		openAddProviderModal,
		openEditProviderModal,
		deleteSelectedProvider,
		saveProvider,
	};
}

export type ProviderActions = ReturnType<typeof createProviderActions>;
