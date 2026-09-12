import { themeNames } from "@devenv/ui";
import { handleAppDetailKeys } from "./app-detail-keys";
import { isDownKey, isUpKey } from "./nav-keys";
import {
	isNextPanelKey,
	isPrevPanelKey,
	isReverseTabKey,
	nextPanelIndex,
	prevPanelIndex,
} from "./panel-keys";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types";

/**
 * Handles keyboard events for table-level views:
 * - Branch selector overlay (ESC/q to close, Enter to checkout, j/k navigation)
 * - Repository detail escape/quit
 * - Table search mode (type query, clear)
 * - Main table navigation (switch with j/k/tab, app operations, view launchers)
 */
export async function handleTableKeys(
	event: KeyboardEvent,
	stores: KeyboardStores,
	actions: KeyboardActions,
	ctx: KeyboardContext,
): Promise<boolean> {
	const { appStore, uiStore } = stores;
	const {
		appActions,
		issueActions,
		logActions,
		crActions,
		dockerActions,
		gitActions,
		providerActions,
		agentActions,
		utilActions,
		helpActions,
	} = actions;
	const { client, getSelectedApp, showError } = ctx;

	// Branch selector overlay keyboard handler (runs while viewMode stays 'table')
	if (uiStore.showBranchSelector()) {
		// Create branch sub-modal guard — intercept all keys while the modal is open
		if (uiStore.showCreateBranchModal()) {
			if (
				event.name === "escape" ||
				event.name === "Escape" ||
				event.name === "esc" ||
				event.sequence === "\x1b" ||
				event.raw === "\x1b"
			) {
				uiStore.setShowCreateBranchModal(false);
				uiStore.setCreateBranchName("");
				return true;
			}
			if (
				event.name === "return" ||
				event.name === "Return" ||
				event.name === "enter" ||
				event.name === "Enter"
			) {
				void gitActions.createBranch();
				return true;
			}
			// All other keys (including printable chars) fall through to the
			// BranchCreateModal's focused <input> element.
			return false;
		}

		const isEsc =
			event.name === "escape" ||
			event.name === "Escape" ||
			event.name === "esc" ||
			event.sequence === "\x1b" ||
			event.raw === "\x1b";

		if (isEsc) {
			if (uiStore.branchFilterActive() || uiStore.branchFilterQuery()) {
				uiStore.setBranchFilterActive(false);
				uiStore.setBranchFilterQuery("");
				uiStore.setBranchSelectorIndex(0);
				return true;
			}
			// Second Esc (or Esc with no active filter): close the selector
			gitActions.closeBranchSelector();
			return true;
		}
		if (
			event.name === "return" ||
			event.name === "Return" ||
			event.name === "enter" ||
			event.name === "Enter"
		) {
			if (uiStore.branchFilterActive()) {
				// Enter in filter mode: finish filtering, return focus to the list
				uiStore.setBranchFilterActive(false);
				return true;
			}
			if (uiStore.branchSelectorWorktreeCreateMode()) {
				void gitActions.createWorktreeFromBranchSelector();
			} else {
				void gitActions.performCheckout();
			}
			return true;
		}
		if (isDownKey(event)) {
			uiStore.setBranchSelectorIndex((prev) =>
				Math.min(prev + 1, uiStore.filteredBranches().length - 1),
			);
			return true;
		}
		if (isUpKey(event)) {
			uiStore.setBranchSelectorIndex((prev) => Math.max(prev - 1, 0));
			return true;
		}
		// ctrl+n: open the create branch sub-modal — only in normal branch mode, not worktree create mode
		if (
			event.ctrl &&
			event.name === "n" &&
			!uiStore.branchSelectorWorktreeCreateMode()
		) {
			uiStore.setCreateBranchName("");
			uiStore.setShowCreateBranchModal(true);
			return true;
		}
		// / — activate filter mode (focuses the ListViewModal built-in filter input)
		if (event.sequence === "/" && !uiStore.branchFilterActive()) {
			uiStore.setBranchFilterQuery("");
			uiStore.setBranchFilterActive(true);
			return true;
		}
		// When filter is active: let the focused <input> handle printable keys
		if (uiStore.branchFilterActive()) {
			return false;
		}
		// Normal mode only: letter-based navigation
		const branchMaxIdx = uiStore.filteredBranches().length - 1;
		const branchPageSize = (() => {
			const rows = process.stdout.rows ?? 24;
			return Math.max(1, Math.max(5, Math.floor(rows * 0.7) - 5 - 2));
		})();
		if (isDownKey(event)) {
			uiStore.setBranchSelectorIndex((prev) =>
				Math.min(prev + 1, branchMaxIdx),
			);
			return true;
		}
		if (isUpKey(event)) {
			uiStore.setBranchSelectorIndex((prev) => Math.max(prev - 1, 0));
			return true;
		}
		if (event.name === "d") {
			uiStore.setBranchSelectorIndex((prev) =>
				Math.min(prev + Math.floor(branchPageSize / 2), branchMaxIdx),
			);
			return true;
		}
		if (event.name === "u") {
			uiStore.setBranchSelectorIndex((prev) =>
				Math.max(prev - Math.floor(branchPageSize / 2), 0),
			);
			return true;
		}
		// Action keybinds (non-worktree mode only)
		if (!uiStore.branchSelectorWorktreeCreateMode()) {
			// s — switch/checkout the selected branch
			if (event.sequence === "s") {
				void gitActions.performCheckout();
				return true;
			}
			// Shift+L — open lazygit log for the selected branch
			if (
				event.sequence === "L" ||
				event.name === "L" ||
				(event.name === "l" && event.shift)
			) {
				const selectedBranch =
					uiStore.filteredBranches()[uiStore.branchSelectorIndex()];
				if (selectedBranch)
					utilActions.launchLazygitBranchLog(selectedBranch.name);
				return true;
			}
			// f — git fetch
			if (event.sequence === "f") {
				void gitActions.performGitFetch();
				return true;
			}
			// p — git pull
			if (event.sequence === "p") {
				void gitActions.performGitPull();
				return true;
			}
			// P — git push (Shift+P)
			if (event.sequence === "P") {
				void gitActions.performGitPush();
				return true;
			}
			// g — open lazygit on the status panel
			if (event.sequence === "g") {
				utilActions.launchLazygitStatus();
				return true;
			}
		}
		// Normal mode: consume all other keys (no accidental typing)
		return true;
	}

	// Table view navigation
	// Note: For case-sensitive letter detection, we need to check event.sequence
	// For special keys (arrows, etc), event.name is reliable
	// Strategy: If sequence is a single letter, use it; otherwise use name

	if (appStore.viewMode() === "appDetail") {
		// Delegate to dependency tree handler first
		if (
			await handleAppDetailKeys(
				event,
				stores.appDetailStore,
				stores.appStore,
				appActions.expandDependencyNode,
			)
		) {
			return true;
		}
		if (
			event.name === "escape" ||
			event.name === "esc" ||
			event.sequence === "\x1b"
		) {
			appActions.closeAppDetail();
		}
		return true;
	}

	// Only handle table mode from here
	if (appStore.viewMode() !== "table") return false;

	const isLetter =
		event.sequence &&
		event.sequence.length === 1 &&
		/[a-zA-Z]/.test(event.sequence);
	const key = isLetter ? event.sequence : event.name;

	if (appStore.showTableFilterModal()) {
		const params = appStore.tableFilterParameters();
		const param = params[appStore.tableFilterParameterIndex()];
		const values = param?.values ?? [];
		if (
			key === "escape" ||
			key === "esc" ||
			event.sequence === "\x1b" ||
			key === "return" ||
			key === "enter"
		) {
			appStore.setShowTableFilterModal(false);
			appStore.setSelectedIndex(0);
			return true;
		}
		if (key === "x") {
			appStore.setTableFilters({});
			appStore.setSelectedIndex(0);
			return true;
		}
		if (key === "j" || key === "down") {
			if (appStore.tableFilterFocusedPane() === "parameter") {
				appStore.setTableFilterParameterIndex((i) =>
					Math.min(params.length - 1, i + 1),
				);
				appStore.setTableFilterValueIndex(0);
			} else {
				appStore.setTableFilterValueIndex((i) =>
					Math.min(values.length - 1, i + 1),
				);
			}
			return true;
		}
		if (key === "k" || key === "up") {
			if (appStore.tableFilterFocusedPane() === "parameter") {
				appStore.setTableFilterParameterIndex((i) => Math.max(0, i - 1));
				appStore.setTableFilterValueIndex(0);
			} else {
				appStore.setTableFilterValueIndex((i) => Math.max(0, i - 1));
			}
			return true;
		}
		if (key === "l" || key === "right") {
			appStore.setTableFilterFocusedPane("value");
			return true;
		}
		if (key === "h" || key === "left") {
			appStore.setTableFilterFocusedPane("parameter");
			return true;
		}
		if (
			event.sequence === " " &&
			param &&
			values[appStore.tableFilterValueIndex()]
		) {
			const value = values[appStore.tableFilterValueIndex()].value;
			appStore.setTableFilters((filters) => {
				const current = filters[param.key] ?? [];
				const next = current.includes(value)
					? current.filter((v) => v !== value)
					: [...current, value];
				return { ...filters, [param.key]: next };
			});
			appStore.setSelectedIndex(0);
			return true;
		}
		return true;
	}

	if (appStore.showTableSortModal()) {
		const rules = appStore.tableSortRules();
		const selected = appStore.tableSortSelectedIndex();
		if (
			key === "escape" ||
			key === "esc" ||
			event.sequence === "\x1b" ||
			key === "return" ||
			key === "enter"
		) {
			appStore.setShowTableSortModal(false);
			appStore.setSelectedIndex(0);
			return true;
		}
		if (key === "x") {
			appStore.setTableSortRules((current) =>
				current.map((rule) => ({ ...rule, direction: "none" })),
			);
			appStore.setSelectedIndex(0);
			return true;
		}
		if (key === "j" || key === "down") {
			appStore.setTableSortSelectedIndex((i) =>
				Math.min(rules.length - 1, i + 1),
			);
			return true;
		}
		if (key === "k" || key === "up") {
			appStore.setTableSortSelectedIndex((i) => Math.max(0, i - 1));
			return true;
		}
		if (event.sequence === " ") {
			const order = ["asc", "desc", "none"] as const;
			appStore.setTableSortRules((current) =>
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
			appStore.setSelectedIndex(0);
			return true;
		}
		if (event.sequence === "K" && selected > 0) {
			appStore.setTableSortRules((current) => {
				const next = [...current];
				[next[selected - 1], next[selected]] = [
					next[selected],
					next[selected - 1],
				];
				return next;
			});
			appStore.setTableSortSelectedIndex(selected - 1);
			appStore.setSelectedIndex(0);
			return true;
		}
		if (event.sequence === "J" && selected < rules.length - 1) {
			appStore.setTableSortRules((current) => {
				const next = [...current];
				[next[selected], next[selected + 1]] = [
					next[selected + 1],
					next[selected],
				];
				return next;
			});
			appStore.setTableSortSelectedIndex(selected + 1);
			appStore.setSelectedIndex(0);
			return true;
		}
		return true;
	}

	// Table search mode — capture all keys while user is typing
	if (appStore.tableSearchMode()) {
		if (
			event.name === "escape" ||
			event.name === "Escape" ||
			event.name === "esc" ||
			event.sequence === "\x1b"
		) {
			appStore.setTableSearchMode(false);
			appStore.setTableSearchQuery("");
			appStore.setSelectedIndex(0);
			return true;
		}
		if (event.name === "return" || event.name === "enter") {
			appStore.setTableSearchMode(false);
			appStore.setSelectedIndex(0);
			return true;
		}
		if (event.name === "backspace" || event.name === "delete") {
			appStore.setTableSearchQuery((q) => q.slice(0, -1));
			appStore.setSelectedIndex(0);
			return true;
		}
		const ch = event.sequence ?? event.name ?? "";
		if (ch.length === 1 && ch >= " ") {
			appStore.setTableSearchQuery((q) => q + ch);
			appStore.setSelectedIndex(0);
			return true;
		}
		return true; // swallow all other keys
	}

	const appList = appStore.tableFilteredApps();
	if (
		event.sequence === "?" ||
		event.name === "?" ||
		(event.name === "/" && event.shift)
	) {
		helpActions.showHelp();
		return true;
	}

	if (appStore.activeTab() === "kubernetes") {
		// Panel focus navigation for Kubernetes panels
		const panelCount = appStore.kubernetesPanelCount;
		if (panelCount > 1) {
			if (isNextPanelKey(event)) {
				appStore.setKubernetesPanelIndex((prev) =>
					nextPanelIndex(prev, panelCount),
				);
				return true;
			}
			if (isPrevPanelKey(event)) {
				appStore.setKubernetesPanelIndex((prev) =>
					prevPanelIndex(prev, panelCount),
				);
				return true;
			}
		}

		switch (key) {
			case "s":
				void dockerActions.createCluster();
				return true;
			case "S":
				dockerActions.requestDeleteCluster();
				return true;
			case "R":
				dockerActions.requestRecreateCluster();
				return true;
			case "r":
				void dockerActions.refreshKubernetesCluster();
				return true;
			case "e":
				void dockerActions.exportKubeconfig();
				return true;
			case "9":
				utilActions.launchK9s();
				return true;
		}
	}

	switch (key) {
		case "/":
			if (appStore.activeTab() === "ui-test") break;
			appStore.setTableSearchMode(true);
			appStore.setTableSearchQuery("");
			appStore.setSelectedIndex(0);
			break;
		case "F":
			if (appStore.activeTab() === "ui-test") break;
			appStore.setShowTableFilterModal(true);
			break;
		case "O":
			if (appStore.activeTab() === "ui-test") break;
			appStore.setShowTableSortModal(true);
			break;
		case "T": {
			const current = uiStore.activeThemeName();
			uiStore.setThemePickerOriginalTheme(current);
			uiStore.setThemePickerFilterActive(false);
			uiStore.setThemePickerFilterQuery("");
			uiStore.setThemePickerSelectedIndex(
				Math.max(0, themeNames.indexOf(current)),
			);
			uiStore.setShowThemePicker(true);
			break;
		}
		case "return":
		case "enter":
			if (appStore.activeTab() === "scripts") {
				const selected = appList[appStore.selectedIndex()];
				if (selected?.resourceType === "script-folder") {
					appActions.toggleScriptFolder();
				} else if (selected?.resourceType === "script-file") {
					// openTaskArgsModal fetches metadata from server and shows modal if params exist
					void utilActions.openTaskArgsModal();
				}
			} else if (appList.length > 0) {
				void appActions.openAppDetail();
			}
			break;
		case "escape":
			if (appStore.tableSearchQuery()) {
				// Clear active search on first Esc
				appStore.setTableSearchQuery("");
				appStore.setSelectedIndex(0);
			} else {
				appStore.resetViewStack("table");
			}
			break;
		case "tab":
		case "\t":
			appStore.setActiveTab((tab) => {
				const tabs = appStore.tableTabs().map((item) => item.id);
				const current = Math.max(0, tabs.indexOf(tab));
				const offset = isReverseTabKey(event) ? -1 : 1;
				return (
					tabs[(current + offset + tabs.length) % tabs.length] ?? "applications"
				);
			});
			appStore.setSelectedIndex(0); // Reset selection when switching tabs
			appStore.setTableSearchQuery("");
			appStore.setTableSearchMode(false);
			if (appStore.activeTab() === "scripts") void appActions.loadScripts();
			break;
		case "1":
			appStore.setActiveTab("applications");
			appStore.setSelectedIndex(0);
			appStore.setTableSearchQuery("");
			appStore.setTableSearchMode(false);
			break;
		case "2":
			appStore.setActiveTab("infrastructure");
			appStore.setSelectedIndex(0);
			appStore.setTableSearchQuery("");
			appStore.setTableSearchMode(false);
			break;
		case "3":
			appStore.setActiveTab("libraries");
			appStore.setSelectedIndex(0);
			appStore.setTableSearchQuery("");
			appStore.setTableSearchMode(false);
			break;
		case "4":
			appStore.setActiveTab("scripts");
			appStore.setSelectedIndex(0);
			appStore.setTableSearchQuery("");
			appStore.setTableSearchMode(false);
			void appActions.loadScripts();
			break;
		case "5":
			appStore.setActiveTab("kubernetes");
			appStore.setKubernetesPanelIndex(0);
			appStore.setSelectedIndex(0);
			appStore.setTableSearchQuery("");
			appStore.setTableSearchMode(false);
			break;
		case "down":
		case "Down":
		case "j":
			// Kubernetes tab: delegate j to focused panel's scrollbox
			if (appStore.activeTab() === "kubernetes") {
				const refs = appStore.kubernetesScrollBoxRefs;
				const ref = refs[appStore.kubernetesPanelIndex()];
				ref?.scrollBy(1);
				if (ref) break;
			}
			if (appList.length > 0) {
				appStore.setSelectedIndex((prev) =>
					Math.min(prev + 1, appList.length - 1),
				);
			}
			break;
		case "up":
		case "Up":
		case "k":
			// Kubernetes tab: delegate k to focused panel's scrollbox
			if (appStore.activeTab() === "kubernetes") {
				const refs = appStore.kubernetesScrollBoxRefs;
				const ref = refs[appStore.kubernetesPanelIndex()];
				ref?.scrollBy(-1);
				if (ref) break;
			}
			if (appList.length > 0) {
				appStore.setSelectedIndex((prev) => Math.max(prev - 1, 0));
			}
			break;
		case "l":
			if (appStore.activeTab() !== "scripts" && appList.length > 0)
				logActions.loadContainerLogs();
			break;
		case "L":
			appStore.pushModal("actions");
			break;
		case "m":
			// Show CR detail for current branch (lowercase m)
			if (appStore.activeTab() !== "scripts" && appList.length > 0)
				crActions.loadChangeRequestForCurrentBranch();
			break;
		case "M":
			// Show all open CRs list (uppercase M / Shift+M)
			if (appStore.activeTab() !== "scripts" && appList.length > 0)
				crActions.loadAllChangeRequests();
			break;
		case "i":
			// Open issues for current project (lowercase i)
			if (appStore.activeTab() !== "scripts" && appList.length > 0)
				void issueActions.loadAllIssues();
			break;
		case "I":
			// Load all issues directly (uppercase I / Shift+I)
			if (appStore.activeTab() !== "scripts" && appList.length > 0)
				issueActions.loadAllIssues();
			break;
		case "c":
			providerActions.loadProviders();
			break;
		case "9":
			utilActions.launchK9s();
			break;
		case "s":
			if (appStore.activeTab() === "scripts") {
				if (appList.length > 0) {
					// openTaskArgsModal fetches metadata from server and shows modal if params exist
					void utilActions.openTaskArgsModal();
				}
				break;
			}
			// Start selected item.
			if (appList.length > 0) {
				// getSelectedApp intentionally excludes rowKind:"infra". Resolve
				// infrastructure from its own registry, or `s` silently exits before
				// invoking the start operation.
				const selectedRow = appList[appStore.selectedIndex()];
				const infra =
					selectedRow?.rowKind === "infra"
						? appStore
								.infraServices()
								.find((svc) => svc.ident === selectedRow.ident)
						: undefined;
				const app = infra ?? getSelectedApp();
				if (!app) break;
				if (app.operationStatus?.status === "active") {
					appStore.pushModal("actions");
					break;
				}
				if (appStore.operationInProgressForApp()) {
					const activeIdent = appStore.operationInProgressForApp();
					if (!activeIdent) break;
					const _active =
						appStore.apps().find((a) => a.ident === activeIdent) ||
						appStore.infraServices().find((svc) => svc.ident === activeIdent) ||
						app;
					appStore.pushModal("actions");
					break;
				}
				if (infra) {
					dockerActions.openInfrastructureStartTargetPicker(infra);
				} else {
					void dockerActions.performAppAction("run");
				}
			}
			break;
		case "S":
			if (appStore.activeTab() === "scripts") {
				if (appList.length > 0) void utilActions.openTaskArgsModal();
				break;
			}
			// Stop container (uppercase S)
			if (appStore.activeTab() !== "scripts" && appList.length > 0)
				dockerActions.requestDockerOperation("stop");
			break;
		case "r":
			// Manual refresh (lowercase r)
			if (appStore.activeTab() === "scripts") void appActions.loadScripts();
			else appActions.fetchStatus();
			break;
		case "R":
			// Restart container (uppercase R / Shift+R)
			if (appStore.activeTab() !== "scripts" && appList.length > 0)
				dockerActions.requestDockerOperation("restart");
			break;
		case "f":
			// Git fetch (lowercase f)
			if (appStore.activeTab() !== "scripts" && appList.length > 0)
				gitActions.performGitFetch();
			break;
		case "g":
			// Branch selector (lowercase g)
			if (appStore.activeTab() !== "scripts" && appList.length > 0)
				gitActions.openBranchSelector();
			break;
		case "w": {
			// Worktree manager (lowercase w)
			if (appStore.activeTab() !== "scripts" && appList.length > 0) {
				const app = getSelectedApp();
				if (app) {
					uiStore.setWorktreeManagerAppId(app.ident);
					uiStore.setWorktreeManagerSelectedIndex(0);
					uiStore.setWorktreeManagerWorktrees([]);
					uiStore.setShowWorktreeManagerModal(true);
					client
						.listWorktrees(app.ident)
						.then((wts) => {
							uiStore.setWorktreeManagerWorktrees(wts);
							// Re-clamp the index in case the user pressed j/k before the list arrived
							uiStore.setWorktreeManagerSelectedIndex((prev) =>
								Math.min(Math.max(prev, 0), Math.max(0, wts.length - 1)),
							);
						})
						.catch((e) => {
							uiStore.setShowWorktreeManagerModal(false);
							uiStore.setWorktreeManagerAppId(null);
							showError(
								"Failed to Load Worktrees",
								`Could not load worktrees for ${app.displayName}.\n\nError: ${e instanceof Error ? e.message : "Unknown error"}`,
							);
						});
				}
			}
			break;
		}
		case "e":
			// Open selected item directory in default editor ($EDITOR)
			if (appList.length > 0) utilActions.openInEditor();
			break;
		case "E":
			// Open editor picker to choose which editor to use (Shift+E)
			if (appList.length > 0) utilActions.openEditorPicker();
			break;
		case "G":
			// Open selected repository in lazygit (Shift+G)
			if (appStore.activeTab() !== "scripts" && appList.length > 0)
				utilActions.launchLazygit();
			break;
		case "d":
			// Open lazydocker for selected item
			if (appStore.activeTab() !== "scripts" && appList.length > 0)
				utilActions.launchLazydocker();
			break;
		case "b":
		case "B": {
			// Build. If already running, open unified action history.
			if (appStore.activeTab() !== "scripts" && appList.length > 0) {
				const selected = getSelectedApp();
				if (!selected) break;
				const app =
					appStore.apps().find((a) => a.ident === selected.ident) ?? selected;
				if (
					app.operationStatus?.operation === "build" &&
					app.operationStatus.status === "active"
				) {
					appStore.pushModal("actions");
				} else {
					void dockerActions.performBuild();
				}
			}
			break;
		}
		case "t": {
			// Test. If already running, open unified action history.
			if (appStore.activeTab() !== "scripts" && appList.length > 0) {
				const selected = getSelectedApp();
				if (!selected) break;
				const app =
					appStore.apps().find((a) => a.ident === selected.ident) ?? selected;
				if (
					app.operationStatus?.operation === "test" &&
					app.operationStatus.status === "active"
				) {
					appStore.pushModal("actions");
				} else {
					void dockerActions.performTest();
				}
			}
			break;
		}
		case "A":
			// Open pi session view (uppercase A)
			agentActions.openAgentView();
			break;
		case "H":
			// Open SSH host picker (uppercase H)
			utilActions.openSshPicker();
			break;
		case "+":
			if (appStore.activeTab() === "scripts")
				void appActions.openAddTaskModal();
			else void providerActions.openAddRepositoryModal();
			break;
		case "-":
			if (appStore.activeTab() === "scripts") appActions.requestRemoveTask();
			else appActions.requestRemoveApp();
			break;
	}

	return true;
}
