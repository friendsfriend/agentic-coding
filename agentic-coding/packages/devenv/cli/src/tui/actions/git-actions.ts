import type { DevEnvClient } from "@devenv/core";
import { getLogger } from "@devenv/core";
import type { AppStore } from "../stores/app-store";
import type { UiStore } from "../stores/ui-store";

export function createGitActions(
	appStore: AppStore,
	uiStore: UiStore,
	client: DevEnvClient,
	showError: (title: string, message: string) => void,
) {
	const getSelectedApp = () => {
		const row = appStore.tableFilteredApps()[appStore.selectedIndex()];
		return row?.rowKind === "app" ? row : undefined;
	};

	const logActionDiagnostic = (
		app: { ident: string; displayName: string },
		operation: string,
		status: string,
		message: string,
	) => {
		getLogger().write(
			status === "failed" ? "ERROR" : "INFO",
			`${operation} ${app.ident}: ${message}`,
		);
	};

	const performGitPull = async () => {
		if (appStore.operationInProgressForApp())
			return showError(
				"Operation In Progress",
				"Another operation is already in progress. Please wait for it to complete.",
			);
		const app = getSelectedApp();
		if (!app) return;
		logActionDiagnostic(app, "pull", "in progress", `Pulling ${app.branch}...`);
		uiStore.setLoadingModalMessage(
			`Pulling ${app.displayName} (${app.branch})...`,
		);
		uiStore.setShowLoadingModal(true);
		try {
			await client.gitPull(app.ident);
			logActionDiagnostic(app, "pull", "completed", `Pulled ${app.branch}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			logActionDiagnostic(app, "pull", "failed", msg);
			showError(
				"Git Pull Failed",
				`Failed to pull changes for ${app.displayName}.\n\nError: ${msg}`,
			);
		} finally {
			uiStore.setShowLoadingModal(false);
		}
	};

	const performGitPush = async () => {
		if (appStore.operationInProgressForApp())
			return showError(
				"Operation In Progress",
				"Another operation is already in progress. Please wait for it to complete.",
			);
		const app = getSelectedApp();
		if (!app) return;
		logActionDiagnostic(app, "push", "in progress", `Pushing ${app.branch}...`);
		uiStore.setLoadingModalMessage(
			`Pushing ${app.displayName} (${app.branch})...`,
		);
		uiStore.setShowLoadingModal(true);
		try {
			await client.gitPush(app.ident);
			logActionDiagnostic(app, "push", "completed", `Pushed ${app.branch}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			logActionDiagnostic(app, "push", "failed", msg);
			showError(
				"Git Push Failed",
				`Failed to push changes for ${app.displayName}.\n\nError: ${msg}`,
			);
		} finally {
			uiStore.setShowLoadingModal(false);
		}
	};

	const performGitFetch = async () => {
		if (appStore.operationInProgressForApp())
			return showError(
				"Operation In Progress",
				"Another operation is already in progress. Please wait for it to complete.",
			);
		const app = getSelectedApp();
		if (!app) return;
		logActionDiagnostic(
			app,
			"fetch",
			"in progress",
			`Fetching ${app.displayName}...`,
		);
		uiStore.setLoadingModalMessage(`Fetching ${app.displayName}...`);
		uiStore.setShowLoadingModal(true);
		try {
			await client.gitFetch(app.ident);
			logActionDiagnostic(
				app,
				"fetch",
				"completed",
				`Fetch completed for ${app.displayName}`,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			logActionDiagnostic(app, "fetch", "failed", msg);
			showError(
				"Git Fetch Failed",
				`Failed to fetch changes for ${app.displayName}.\n\nError: ${msg}`,
			);
		} finally {
			uiStore.setShowLoadingModal(false);
		}
	};

	const openBranchSelector = async () => {
		if (appStore.operationInProgressForApp())
			return showError(
				"Operation In Progress",
				"Another operation is already in progress. Please wait for it to complete.",
			);
		const app = getSelectedApp();
		if (!app) return;
		uiStore.setTargetAppForBranch(app);
		uiStore.setBranchesLoading(true);
		uiStore.setShowBranchSelector(true);
		uiStore.setBranches([]);
		uiStore.setWorktrees([]);
		uiStore.setBranchSelectorIndex(0);
		uiStore.setBranchSelectorWorktreeCreateMode(false);
		try {
			const response = await client.getBranches(app.ident);
			getLogger().write("INFO", "Branch response:", JSON.stringify(response));
			const local = (response.localBranches || []).map((name: string) => ({
				name,
				isRemote: false,
			}));
			const remote = (response.remoteBranches || []).map((name: string) => ({
				name,
				isRemote: true,
			}));
			const localNames = new Set(local.map((b) => b.name));
			const uniqueRemote = remote.filter(
				(b) => !localNames.has(b.name.replace(/^origin\//, "")),
			);
			const allBranches = [...local, ...uniqueRemote];
			const currentIdx = allBranches.findIndex(
				(b) =>
					b.name === response.currentBranch ||
					b.name === `origin/${response.currentBranch}`,
			);
			if (currentIdx >= 0) uiStore.setBranchSelectorIndex(currentIdx);
			uiStore.setBranches(allBranches);
		} catch (e) {
			const app = uiStore.targetAppForBranch();
			closeBranchSelector();
			showError(
				"Failed to Load Branches",
				`Could not load branches for ${app?.displayName || "Unknown Repository"}.\n\nError: ${e instanceof Error ? e.message : "Unknown error"}`,
			);
		} finally {
			uiStore.setBranchesLoading(false);
		}
	};

	/**
	 * Opens the branch selector from the worktree manager to select a branch for a new worktree.
	 * Enter in this mode calls createWorktreeFromBranchSelector instead of performCheckout.
	 */
	const openBranchSelectorForNewWorktree = async (appId: string) => {
		const app = appStore.apps().find((a) => a.ident === appId);
		if (!app) return;
		uiStore.setTargetAppForBranch(app);
		uiStore.setBranchesLoading(true);
		uiStore.setShowBranchSelector(true);
		uiStore.setBranches([]);
		uiStore.setWorktrees([]);
		uiStore.setBranchSelectorIndex(0);
		uiStore.setBranchFilterQuery("");
		uiStore.setBranchSelectorWorktreeCreateMode(true);
		try {
			const response = await client.getBranches(app.ident);
			const local = (response.localBranches || []).map((name: string) => ({
				name,
				isRemote: false,
			}));
			const remote = (response.remoteBranches || []).map((name: string) => ({
				name,
				isRemote: true,
			}));
			const localNames = new Set(local.map((b) => b.name));
			const uniqueRemote = remote.filter(
				(b) => !localNames.has(b.name.replace(/^origin\//, "")),
			);
			uiStore.setBranches([...local, ...uniqueRemote]);
		} catch (e) {
			closeBranchSelector();
			showError(
				"Failed to Load Branches",
				`Could not load branches for ${app.displayName}.\n\nError: ${e instanceof Error ? e.message : "Unknown error"}`,
			);
		} finally {
			uiStore.setBranchesLoading(false);
		}
	};

	const closeBranchSelector = () => {
		uiStore.setShowBranchSelector(false);
		uiStore.setBranches([]);
		uiStore.setWorktrees([]);
		uiStore.setBranchSelectorIndex(0);
		uiStore.setTargetAppForBranch(null);
		uiStore.setBranchFilterQuery("");
		uiStore.setBranchFilterActive(false);
		uiStore.setBranchSelectorWorktreeCreateMode(false);
	};

	const performCheckout = async () => {
		const app = uiStore.targetAppForBranch();
		const selected = uiStore.filteredBranches()[uiStore.branchSelectorIndex()];
		if (!app || !selected) return;
		const branchName = selected.name.startsWith("origin/")
			? selected.name.substring(7)
			: selected.name;
		closeBranchSelector();
		logActionDiagnostic(
			app,
			"checkout",
			"in progress",
			`Checking out ${branchName}...`,
		);
		uiStore.setLoadingModalMessage(`Checking out ${branchName}...`);
		uiStore.setShowLoadingModal(true);
		try {
			await client.gitCheckout(app.ident, branchName);
			logActionDiagnostic(
				app,
				"checkout",
				"completed",
				`Checked out ${branchName}`,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			logActionDiagnostic(app, "checkout", "failed", msg);
			showError(
				"Git Checkout Failed",
				`Failed to checkout branch "${selected.name}" for ${app.displayName}.\n\nError: ${msg}`,
			);
		} finally {
			uiStore.setShowLoadingModal(false);
		}
	};

	const createBranch = async () => {
		const app = uiStore.targetAppForBranch();
		const branchName = uiStore.createBranchName().trim();
		if (!app || !branchName) return;

		uiStore.setShowCreateBranchModal(false);
		uiStore.setCreateBranchName("");
		closeBranchSelector();
		logActionDiagnostic(
			app,
			"create-branch",
			"in progress",
			`Creating branch ${branchName}...`,
		);
		uiStore.setLoadingModalMessage(`Creating branch ${branchName}...`);
		uiStore.setShowLoadingModal(true);
		try {
			await client.gitCreateBranch(app.ident, branchName);
			logActionDiagnostic(
				app,
				"create-branch",
				"completed",
				`Created branch ${branchName}`,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			logActionDiagnostic(app, "create-branch", "failed", msg);
			showError(
				"Create Branch Failed",
				`Failed to create branch "${branchName}" for ${app.displayName}.\n\nError: ${msg}`,
			);
		} finally {
			uiStore.setShowLoadingModal(false);
		}
	};

	/**
	 * Called from the branch selector when in worktree-create mode.
	 * Resolves the branch name from the selection/filter and creates the worktree directly.
	 */
	const createWorktreeFromBranchSelector = async () => {
		const app = uiStore.targetAppForBranch();
		if (!app) return;

		const filtered = uiStore.filteredBranches();
		const filterQuery = uiStore.branchFilterQuery().trim();

		// If filter has text but no matches, treat the filter text as the new branch name
		let branchName: string;
		if (filtered.length === 0 && filterQuery) {
			branchName = filterQuery;
		} else {
			const selected = filtered[uiStore.branchSelectorIndex()];
			if (!selected) return;
			branchName = selected.name.startsWith("origin/")
				? selected.name.substring(7)
				: selected.name;
		}

		closeBranchSelector();
		logActionDiagnostic(
			app,
			"create-worktree",
			"in progress",
			`Creating worktree ${branchName}...`,
		);
		uiStore.setLoadingModalMessage(
			`Creating worktree ${branchName} (${app.displayName})...`,
		);
		uiStore.setShowLoadingModal(true);
		try {
			await client.createWorktree(app.ident, branchName);
			// Refresh the worktree manager list
			const updated = await client.listWorktrees(app.ident);
			uiStore.setWorktreeManagerWorktrees(updated);
			logActionDiagnostic(
				app,
				"create-worktree",
				"completed",
				`Created worktree ${branchName}`,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			logActionDiagnostic(app, "create-worktree", "failed", msg);
			showError(
				"Create Worktree Failed",
				`Failed to create worktree for "${branchName}".\n\nError: ${msg}`,
			);
		} finally {
			uiStore.setShowLoadingModal(false);
		}
	};

	const removeWorktreeAction = async () => {
		const app = uiStore.targetAppForBranch();
		const selected = uiStore.filteredBranches()[uiStore.branchSelectorIndex()];
		if (!app || !selected) return;
		const branchName = selected.name.startsWith("origin/")
			? selected.name.substring(7)
			: selected.name;
		const isActive = branchName === app.activeWorktree;
		const isMain = branchName === app.mainWorktreeBranch;
		if (isActive || isMain) {
			return showError(
				"Cannot Remove Worktree",
				"Cannot remove the active or primary worktree.",
			);
		}
		closeBranchSelector();
		logActionDiagnostic(
			app,
			"remove-worktree",
			"in progress",
			`Removing worktree ${branchName}...`,
		);
		uiStore.setLoadingModalMessage(
			`Removing worktree ${branchName} (${app.displayName})...`,
		);
		uiStore.setShowLoadingModal(true);
		try {
			await client.removeWorktree(app.ident, branchName);
			logActionDiagnostic(
				app,
				"remove-worktree",
				"completed",
				`Removed worktree ${branchName}`,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			logActionDiagnostic(app, "remove-worktree", "failed", msg);
			showError(
				"Remove Worktree Failed",
				`Failed to remove worktree "${branchName}".\n\nError: ${msg}`,
			);
		} finally {
			uiStore.setShowLoadingModal(false);
		}
	};

	const removeWorktreeFromManager = async () => {
		const appId = uiStore.worktreeManagerAppId();
		const worktrees = uiStore.worktreeManagerWorktrees();
		const idx = uiStore.worktreeManagerSelectedIndex();
		const selected = worktrees[idx];
		if (!appId || !selected) return;

		const app = appStore.apps().find((a) => a.ident === appId);
		if (!app) return;

		if (selected.active || selected.isMain) {
			return showError(
				"Cannot Remove Worktree",
				"Cannot remove the active or primary worktree.",
			);
		}

		logActionDiagnostic(
			app,
			"remove-worktree",
			"in progress",
			`Removing worktree ${selected.branch}...`,
		);
		uiStore.setLoadingModalMessage(
			`Removing worktree ${selected.branch} (${app.displayName})...`,
		);
		uiStore.setShowLoadingModal(true);
		try {
			await client.removeWorktree(appId, selected.branch);
			// Refresh list
			const updated = await client.listWorktrees(appId);
			uiStore.setWorktreeManagerWorktrees(updated);
			// Clamp selected index
			uiStore.setWorktreeManagerSelectedIndex((prev) =>
				Math.min(prev, Math.max(0, updated.length - 1)),
			);
			logActionDiagnostic(
				app,
				"remove-worktree",
				"completed",
				`Removed worktree ${selected.branch}`,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			logActionDiagnostic(app, "remove-worktree", "failed", msg);
			showError(
				"Remove Worktree Failed",
				`Failed to remove worktree "${selected.branch}".\n\nError: ${msg}`,
			);
		} finally {
			uiStore.setShowLoadingModal(false);
		}
	};

	const switchWorktreeFromManager = async () => {
		const appId = uiStore.worktreeManagerAppId();
		const worktrees = uiStore.worktreeManagerWorktrees();
		const idx = Math.max(0, uiStore.worktreeManagerSelectedIndex());
		const selected = worktrees[idx];
		if (!appId || !selected) return;

		// Already the active worktree — nothing to do
		if (selected.active) return;

		const app = appStore.apps().find((a) => a.ident === appId);
		if (!app) return;

		logActionDiagnostic(
			app,
			"switch-worktree",
			"in progress",
			`Switching worktree ${selected.branch}...`,
		);
		uiStore.setLoadingModalMessage(
			`Switching worktree ${selected.branch} (${app.displayName})...`,
		);
		uiStore.setShowLoadingModal(true);
		try {
			await client.switchWorktree(appId, selected.branch);
			// Close the modal
			uiStore.setShowWorktreeManagerModal(false);
			uiStore.setWorktreeManagerAppId(null);
			uiStore.setWorktreeManagerWorktrees([]);
			uiStore.setWorktreeManagerSelectedIndex(0);
			logActionDiagnostic(
				app,
				"switch-worktree",
				"completed",
				`Switched worktree ${selected.branch}`,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			logActionDiagnostic(app, "switch-worktree", "failed", msg);
			showError(
				"Switch Worktree Failed",
				`Failed to switch to worktree "${selected.branch}".\n\nError: ${msg}`,
			);
		} finally {
			uiStore.setShowLoadingModal(false);
		}
	};

	return {
		performGitPull,
		performGitPush,
		performGitFetch,
		openBranchSelector,
		openBranchSelectorForNewWorktree,
		closeBranchSelector,
		performCheckout,
		createBranch,
		createWorktreeFromBranchSelector,
		removeWorktreeAction,
		removeWorktreeFromManager,
		switchWorktreeFromManager,
	};
}

export type GitActions = ReturnType<typeof createGitActions>;
