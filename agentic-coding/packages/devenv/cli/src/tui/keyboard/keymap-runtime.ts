import type { Accessor } from "solid-js";
import { createEffect } from "solid-js";
import type { DevenvKeymap } from "./keymap-setup";
import type { KeyboardStores } from "./types";

export interface KeymapRuntimeSnapshot {
	viewMode: string;
	activeTab: string;
	activeModal: string;
	textEntryActive: boolean;
	shutdownActive: boolean;
	focusedPanel: string;
	focusedList: string;
	worktreeManagerActive: boolean;
}

const bool = (value: unknown): boolean =>
	Boolean(typeof value === "function" ? (value as () => unknown)() : value);
const stringOr = (value: unknown, fallback: string): string =>
	String(
		(typeof value === "function" ? (value as () => unknown)() : value) ??
			fallback,
	);

export function getOpenModalNames(stores: KeyboardStores): string[] {
	const { appStore, uiStore, logStore, changeRequestStore, providerStore } =
		stores;
	return [
		bool(uiStore.showErrorDialog) && "error",
		bool(uiStore.showConfirmDialog) && "confirm",
		bool(uiStore.showMarkdownModal) && "markdown",
		bool(uiStore.showThemePicker) && "theme-picker",
		bool(uiStore.showProfilePicker) && "profile-picker",
		bool(uiStore.showActionTargetPicker) && "action-target-picker",
		bool(providerStore.showAddRepositoryModal) && "add-repository",
		bool(providerStore.showConnectProviderModal) && "connect-provider",
		bool(changeRequestStore.showDiffModal) && "diff",
		bool(changeRequestStore.showCommentModal) && "comment",
		bool(logStore.showLogModal) && "log",
		bool(
			(uiStore as unknown as { showEditorPicker?: unknown }).showEditorPicker,
		) && "editor-picker",
		bool(uiStore.showTaskAddModal) && "task-add",
		bool(uiStore.showTaskArgsModal) && "task-args",
		bool(uiStore.showPassphraseModal) && "passphrase",
		bool(uiStore.showCreateBranchModal) && "branch",
		bool(appStore.showFirstSteps) && "first-steps",
		(appStore.modalStack?.() ?? []).some((route) => route.name === "actions") &&
			"actions",
	].filter((name): name is string => typeof name === "string");
}

export function getActiveModalName(stores: KeyboardStores): string {
	const openModals = getOpenModalNames(stores);
	const appStoreWithModals = stores.appStore as KeyboardStores["appStore"] & {
		syncModalStack?: (openModals: string[]) => void;
		activeModal?: () => string;
	};
	appStoreWithModals.syncModalStack?.(openModals);
	const stacked = appStoreWithModals.activeModal?.();
	if (stacked && stacked !== "none" && openModals.includes(stacked))
		return stacked;
	return openModals.at(-1) ?? "none";
}

export function isKeymapTextEntryActive(stores: KeyboardStores): boolean {
	const {
		appStore,
		uiStore,
		logStore,
		changeRequestStore,
		issueStore,
		agentStore,
		providerStore,
	} = stores;
	return Boolean(
		bool(appStore.tableSearchMode) ||
			bool(uiStore.branchFilterActive) ||
			bool(uiStore.showCreateBranchModal) ||
			bool(uiStore.themePickerFilterActive) ||
			bool(uiStore.taskArgsEditing) ||
			bool(uiStore.showTaskAddModal) ||
			bool(logStore.logSearchMode) ||
			bool(logStore.logAiPromptMode) ||
			bool(changeRequestStore.jobsSearchMode) ||
			bool(changeRequestStore.crSearchMode) ||
			bool(changeRequestStore.changedFilesSearchMode) ||
			bool(changeRequestStore.testSearchMode) ||
			bool(changeRequestStore.replyMode) ||
			bool(changeRequestStore.showCommentModal) ||
			bool(issueStore.issueSearchMode) ||
			bool(agentStore.sshFilterActive) ||
			bool(agentStore.agentFilterActive) ||
			bool(providerStore.showConnectProviderModal) ||
			bool(providerStore.showAddRepositoryModal),
	);
}

export function getFocusedPanelName(stores: KeyboardStores): string {
	const viewMode = stringOr(stores.appStore.viewMode, "table");
	if (stringOr(stores.appStore.activeModal, "none") === "actions")
		return `actions:${stringOr(stores.actionRunStore.focusedPanel, "0")}`;
	if (
		viewMode === "table" &&
		stringOr(stores.appStore.activeTab, "apps") === "kubernetes"
	) {
		return `kubernetes:${stringOr(stores.appStore.kubernetesPanelIndex, "0")}`;
	}
	if (viewMode === "appDetail")
		return `appDetail:${stringOr(stores.appDetailStore.appDetailPanelIndex, "0")}`;
	if (viewMode === "issueDetail")
		return `issueDetail:${stringOr(stores.issueStore.issueDetailPanelIndex, "0")}`;
	if (viewMode === "changeRequestDetail")
		return `changeRequestDetail:${stringOr(stores.changeRequestStore.crDetailPanelIndex, "0")}`;
	return stringOr(
		(stores.uiStore as unknown as { focusedPanel?: unknown }).focusedPanel,
		"none",
	);
}

export function getKeymapRuntimeSnapshot(
	stores: KeyboardStores,
): KeymapRuntimeSnapshot {
	const viewMode = stringOr(stores.appStore.viewMode, "table");
	return {
		viewMode,
		activeTab: stringOr(stores.appStore.activeTab, "apps"),
		activeModal: getActiveModalName(stores),
		textEntryActive: isKeymapTextEntryActive(stores),
		shutdownActive: bool(stores.appStore.isShuttingDown),
		focusedPanel: getFocusedPanelName(stores),
		focusedList: viewMode,
		worktreeManagerActive: bool(
			(stores.uiStore as unknown as { showWorktreeManagerModal?: unknown })
				.showWorktreeManagerModal,
		),
	};
}

export function applyKeymapRuntimeSnapshot(
	keymap: DevenvKeymap,
	snapshot: KeymapRuntimeSnapshot,
): void {
	keymap.setData("app.viewMode", snapshot.viewMode);
	keymap.setData("app.activeTab", snapshot.activeTab);
	keymap.setData("modal.active", snapshot.activeModal);
	keymap.setData("textEntry.active", snapshot.textEntryActive);
	keymap.setData("shutdown.active", snapshot.shutdownActive);
	keymap.setData("focus.panel", snapshot.focusedPanel);
	keymap.setData("focus.list", snapshot.focusedList);
	keymap.setData("worktree.active", snapshot.worktreeManagerActive);
}

export function syncKeymapRuntimeState(
	keymap: DevenvKeymap,
	stores: Accessor<KeyboardStores> | KeyboardStores,
	afterSync?: () => void,
): void {
	createEffect(() => {
		const currentStores = typeof stores === "function" ? stores() : stores;
		applyKeymapRuntimeSnapshot(keymap, getKeymapRuntimeSnapshot(currentStores));
		afterSync?.();
	});
}
