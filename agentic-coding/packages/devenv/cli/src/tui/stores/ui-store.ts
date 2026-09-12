import type {
	ActionTarget,
	App,
	AppAction,
	SshHost,
	WorktreeInfo,
} from "@devenv/types";
import type { BranchInfo, EditorOption } from "@devenv/ui";
import { createMemo, createSignal } from "solid-js";

export type NotificationType = "info" | "success" | "warning" | "error";
export interface Notification {
	message: string;
	type: NotificationType;
}

export function createUiStore() {
	let markdownModalScrollBoxRef:
		| import("@opentui/core").ScrollBoxRenderable
		| undefined;
	let helpKeybindScrollBoxRef:
		| import("@opentui/core").ScrollBoxRenderable
		| undefined;
	let helpGuideScrollBoxRef:
		| import("@opentui/core").ScrollBoxRenderable
		| undefined;
	const [showErrorDialog, setShowErrorDialog] = createSignal(false);
	const [errorDialogTitle, setErrorDialogTitle] = createSignal("Error");
	const [errorDialogMessage, setErrorDialogMessage] = createSignal("");
	const [showConfirmDialog, setShowConfirmDialog] = createSignal(false);
	const [confirmDialogTitle, setConfirmDialogTitle] = createSignal("");
	const [confirmDialogMessage, setConfirmDialogMessage] = createSignal("");
	const [confirmDialogAction, setConfirmDialogAction] = createSignal<
		(() => void) | null
	>(null);
	const [showBranchSelector, setShowBranchSelector] = createSignal(false);
	const [branches, setBranches] = createSignal<BranchInfo[]>([]);
	const [branchSelectorIndex, setBranchSelectorIndex] = createSignal(0);
	const [notification, setNotificationRaw] = createSignal<Notification | null>(
		null,
	);
	const setNotification = (msg: string, type: NotificationType = "success") => {
		setNotificationRaw({ message: msg, type });
		setTimeout(() => setNotificationRaw(null), 3000);
	};
	const [branchesLoading, setBranchesLoading] = createSignal(false);
	const [targetAppForBranch, setTargetAppForBranch] = createSignal<App | null>(
		null,
	);
	const [branchFilterQuery, setBranchFilterQuery] = createSignal("");
	const [branchFilterActive, setBranchFilterActive] = createSignal(false);
	const [worktrees, setWorktrees] = createSignal<WorktreeInfo[]>([]);
	const [showProfilePicker, setShowProfilePicker] = createSignal(false);
	const [profilePickerProfiles, setProfilePickerProfiles] = createSignal<
		string[]
	>([]);
	const [profilePickerHasDockerfile, setProfilePickerHasDockerfile] =
		createSignal(false);
	const [profilePickerLoading, setProfilePickerLoading] = createSignal(false);
	const [profilePickerSelectedIndex, setProfilePickerSelectedIndex] =
		createSignal(0);
	const [profilePickerAppIdent, setProfilePickerAppIdent] = createSignal<
		string | null
	>(null);
	const [showActionTargetPicker, setShowActionTargetPicker] =
		createSignal(false);
	const [actionTargetPickerTargets, setActionTargetPickerTargets] =
		createSignal<ActionTarget[]>([]);
	const [actionTargetPickerLoading, setActionTargetPickerLoading] =
		createSignal(false);
	const [actionTargetPickerSelectedIndex, setActionTargetPickerSelectedIndex] =
		createSignal(0);
	const [actionTargetPickerAppIdent, setActionTargetPickerAppIdent] =
		createSignal<string | null>(null);
	const [actionTargetPickerAction, setActionTargetPickerAction] =
		createSignal<AppAction>("run");
	const [showLoadingModal, setShowLoadingModal] = createSignal(false);
	const [loadingModalMessage, setLoadingModalMessage] =
		createSignal("Loading...");
	const [showPassphraseModal, setShowPassphraseModal] = createSignal(false);
	const [passphraseText, setPassphraseText] = createSignal("");
	const [passphraseError, setPassphraseError] = createSignal<string | null>(
		null,
	);
	const [pendingSshHost, setPendingSshHost] = createSignal<SshHost | null>(
		null,
	);
	const [showEditorPicker, setShowEditorPicker] = createSignal(false);
	const [editorPickerSelectedIndex, setEditorPickerSelectedIndex] =
		createSignal(0);
	const [editorPickerTargetPath, setEditorPickerTargetPath] = createSignal<
		string | null
	>(null);
	const [editorPickerOptions, setEditorPickerOptions] = createSignal<
		EditorOption[]
	>([]);
	const [showThemePicker, setShowThemePicker] = createSignal(false);
	const [themePickerSelectedIndex, setThemePickerSelectedIndex] =
		createSignal(0);
	const [themePickerFilterActive, setThemePickerFilterActive] =
		createSignal(false);
	const [themePickerFilterQuery, setThemePickerFilterQuery] = createSignal("");
	const [activeThemeName, setActiveThemeName] = createSignal("catppuccin");
	const [themePickerOriginalTheme, setThemePickerOriginalTheme] =
		createSignal("catppuccin");
	const [showCreateBranchModal, setShowCreateBranchModal] = createSignal(false);
	const [createBranchName, setCreateBranchName] = createSignal("");
	// When true, the branch selector was opened from the worktree manager to create a new worktree.
	// Enter selects a branch for a new worktree instead of checking it out.
	const [
		branchSelectorWorktreeCreateMode,
		setBranchSelectorWorktreeCreateMode,
	] = createSignal(false);
	const [showWorktreeManagerModal, setShowWorktreeManagerModal] =
		createSignal(false);
	const [worktreeManagerAppId, setWorktreeManagerAppId] = createSignal<
		string | null
	>(null);
	const [worktreeManagerWorktrees, setWorktreeManagerWorktrees] = createSignal<
		WorktreeInfo[]
	>([]);
	const [worktreeManagerSelectedIndex, setWorktreeManagerSelectedIndex] =
		createSignal(0);
	const [showTaskArgsModal, setShowTaskArgsModal] = createSignal(false);
	const [showTaskAddModal, setShowTaskAddModal] = createSignal(false);
	const [taskAddMode, setTaskAddMode] = createSignal<"create" | "link">(
		"create",
	);
	const [taskAddTargetPath, setTaskAddTargetPath] = createSignal("");
	const [taskAddSourcePath, setTaskAddSourcePath] = createSignal("");
	const [taskAddSelectedField, setTaskAddSelectedField] = createSignal(0);
	const [taskAddError, setTaskAddError] = createSignal<string | null>(null);
	const [taskArgsError, setTaskArgsError] = createSignal<string | null>(null);
	const [taskArgsSelectedIndex, setTaskArgsSelectedIndex] = createSignal(0);
	const [taskArgsSelectedValueIndex, setTaskArgsSelectedValueIndex] =
		createSignal(0);
	const [taskArgsFocusedPane, setTaskArgsFocusedPane] = createSignal<
		"parameter" | "value"
	>("parameter");
	const [taskArgsEditing, setTaskArgsEditing] = createSignal(false);
	const [taskArgsEditOriginalValue, setTaskArgsEditOriginalValue] =
		createSignal("");
	const [taskArgsTargetScript, setTaskArgsTargetScript] = createSignal<
		string | null
	>(null);
	const [scriptArgValues, setScriptArgValues] = createSignal<
		Record<string, string>
	>({});
	const [taskArgsHistory, setTaskArgsHistory] = createSignal<
		Record<string, Record<string, string>[]>
	>({});
	const [taskArgsHistoryCursor, setTaskArgsHistoryCursor] = createSignal(-1);
	const [taskArgsParameters, setTaskArgsParameters] = createSignal<
		import("@devenv/types").ScriptParameter[]
	>([]);
	const [showMarkdownModal, setShowMarkdownModal] = createSignal(false);
	const [markdownModalReturnToHelp, setMarkdownModalReturnToHelp] =
		createSignal(false);
	const [markdownModalTitle, setMarkdownModalTitle] = createSignal("");
	const [markdownModalContent, setMarkdownModalContent] = createSignal("");
	const [runningTextEnabled, setRunningTextEnabled] = createSignal(true);
	const [runningTextOffset, setRunningTextOffset] = createSignal(0);

	const filteredBranches = createMemo(() => {
		const query = branchFilterQuery().toLowerCase();
		const allBranches = branches();
		if (!query) return allBranches;
		return allBranches.filter((branch) =>
			branch.name.toLowerCase().includes(query),
		);
	});

	const showError = (title: string, message: string) => {
		setErrorDialogTitle(title);
		setErrorDialogMessage(message);
		setShowErrorDialog(true);
	};

	const taskArgsHistoryForCurrent = createMemo(() => {
		const key = taskArgsTargetScript();
		if (!key) return [] as Record<string, string>[];
		return taskArgsHistory()[key] ?? [];
	});

	return {
		showErrorDialog,
		setShowErrorDialog,
		errorDialogTitle,
		setErrorDialogTitle,
		errorDialogMessage,
		setErrorDialogMessage,
		showConfirmDialog,
		setShowConfirmDialog,
		confirmDialogTitle,
		setConfirmDialogTitle,
		confirmDialogMessage,
		setConfirmDialogMessage,
		confirmDialogAction,
		setConfirmDialogAction,
		showBranchSelector,
		setShowBranchSelector,
		branches,
		setBranches,
		branchSelectorIndex,
		setBranchSelectorIndex,
		notification,
		setNotification,
		branchesLoading,
		setBranchesLoading,
		targetAppForBranch,
		setTargetAppForBranch,
		branchFilterQuery,
		setBranchFilterQuery,
		branchFilterActive,
		setBranchFilterActive,
		worktrees,
		setWorktrees,
		showProfilePicker,
		setShowProfilePicker,
		profilePickerProfiles,
		setProfilePickerProfiles,
		profilePickerHasDockerfile,
		setProfilePickerHasDockerfile,
		profilePickerLoading,
		setProfilePickerLoading,
		profilePickerSelectedIndex,
		setProfilePickerSelectedIndex,
		profilePickerAppIdent,
		setProfilePickerAppIdent,
		showActionTargetPicker,
		setShowActionTargetPicker,
		actionTargetPickerTargets,
		setActionTargetPickerTargets,
		actionTargetPickerLoading,
		setActionTargetPickerLoading,
		actionTargetPickerSelectedIndex,
		setActionTargetPickerSelectedIndex,
		actionTargetPickerAppIdent,
		setActionTargetPickerAppIdent,
		actionTargetPickerAction,
		setActionTargetPickerAction,
		showLoadingModal,
		setShowLoadingModal,
		loadingModalMessage,
		setLoadingModalMessage,
		showPassphraseModal,
		setShowPassphraseModal,
		passphraseText,
		setPassphraseText,
		passphraseError,
		setPassphraseError,
		pendingSshHost,
		setPendingSshHost,
		showEditorPicker,
		setShowEditorPicker,
		editorPickerSelectedIndex,
		setEditorPickerSelectedIndex,
		editorPickerTargetPath,
		setEditorPickerTargetPath,
		editorPickerOptions,
		setEditorPickerOptions,
		showThemePicker,
		setShowThemePicker,
		themePickerSelectedIndex,
		setThemePickerSelectedIndex,
		themePickerFilterActive,
		setThemePickerFilterActive,
		themePickerFilterQuery,
		setThemePickerFilterQuery,
		activeThemeName,
		setActiveThemeName,
		themePickerOriginalTheme,
		setThemePickerOriginalTheme,
		showCreateBranchModal,
		setShowCreateBranchModal,
		createBranchName,
		setCreateBranchName,
		branchSelectorWorktreeCreateMode,
		setBranchSelectorWorktreeCreateMode,
		showWorktreeManagerModal,
		setShowWorktreeManagerModal,
		worktreeManagerAppId,
		setWorktreeManagerAppId,
		worktreeManagerWorktrees,
		setWorktreeManagerWorktrees,
		worktreeManagerSelectedIndex,
		setWorktreeManagerSelectedIndex,
		showTaskArgsModal,
		setShowTaskArgsModal,
		showTaskAddModal,
		setShowTaskAddModal,
		taskAddMode,
		setTaskAddMode,
		taskAddTargetPath,
		setTaskAddTargetPath,
		taskAddSourcePath,
		setTaskAddSourcePath,
		taskAddSelectedField,
		setTaskAddSelectedField,
		taskAddError,
		setTaskAddError,
		taskArgsError,
		setTaskArgsError,
		taskArgsSelectedIndex,
		setTaskArgsSelectedIndex,
		taskArgsSelectedValueIndex,
		setTaskArgsSelectedValueIndex,
		taskArgsFocusedPane,
		setTaskArgsFocusedPane,
		taskArgsEditing,
		setTaskArgsEditing,
		taskArgsEditOriginalValue,
		setTaskArgsEditOriginalValue,
		taskArgsTargetScript,
		setTaskArgsTargetScript,
		scriptArgValues,
		setScriptArgValues,
		taskArgsHistory,
		setTaskArgsHistory,
		taskArgsHistoryCursor,
		setTaskArgsHistoryCursor,
		taskArgsHistoryForCurrent,
		taskArgsParameters,
		setTaskArgsParameters,
		showMarkdownModal,
		setShowMarkdownModal,
		markdownModalReturnToHelp,
		setMarkdownModalReturnToHelp,
		markdownModalTitle,
		setMarkdownModalTitle,
		markdownModalContent,
		setMarkdownModalContent,
		runningTextEnabled,
		setRunningTextEnabled,
		runningTextOffset,
		setRunningTextOffset,
		get markdownModalScrollBoxRef() {
			return markdownModalScrollBoxRef;
		},
		set markdownModalScrollBoxRef(value:
			| import("@opentui/core").ScrollBoxRenderable
			| undefined) {
			markdownModalScrollBoxRef = value;
		},
		get helpKeybindScrollBoxRef() {
			return helpKeybindScrollBoxRef;
		},
		set helpKeybindScrollBoxRef(value:
			| import("@opentui/core").ScrollBoxRenderable
			| undefined) {
			helpKeybindScrollBoxRef = value;
		},
		get helpGuideScrollBoxRef() {
			return helpGuideScrollBoxRef;
		},
		set helpGuideScrollBoxRef(value:
			| import("@opentui/core").ScrollBoxRenderable
			| undefined) {
			helpGuideScrollBoxRef = value;
		},
		filteredBranches,
		showError,
	};
}

export type UiStore = ReturnType<typeof createUiStore>;
