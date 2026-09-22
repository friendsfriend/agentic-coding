/**
 * Shared UI framework — one component set for every surface: the shell (Home,
 * dashboard, observability, wiki), the environment feature and the standalone
 * dashboards.
 *
 * Import from `@ui` (the barrel). `components/` holds the primitives and
 * composites, `theme/` the semantic colours, `views/` the multi-part surfaces
 * (reviews, providers, clusters, change requests, …). One implementation per
 * component; different behaviour is a prop, never a fork.
 */

export * from "@ui";
export * from "@ui";
export * from "@ui";
export * from "@ui";
export * from "./components/AnimatedStatusText.tsx";
export * from "./components/Badge.tsx";
export * from "./components/Card.tsx";
export * from "./components/CenteredState.tsx";
export * from "./components/ChangedFilesView.tsx";
export * from "./components/ContentStack.tsx";
export * from "./components/diffView.ts";
export * from "./components/ErrorDialog.tsx";
export * from "./components/ErrorModalOverlay.tsx";
export * from "./components/errorModal.ts";
export * from "./components/FilterModal.tsx";
export * from "./components/FilterStatusBar.tsx";
export * from "./components/FrontmatterView.tsx";
export * from "./components/GenericModal.tsx";
export * from "./components/Header.tsx";
export * from "./components/HelpModal.tsx";
export * from "./components/HelpText.tsx";
export * from "./components/Highlight.tsx";
export * from "./components/hostChrome.ts";
export * from "./components/hostKeys.ts";
export * from "./components/InlineProgressAnimation.tsx";
export * from "./components/keybinds.ts";
export * from "./components/Layout.tsx";
export * from "./components/ListViewModal.tsx";
export * from "./components/LogView.tsx";
export * from "./components/MarkdownViewer.tsx";
export * from "./components/MatchedText.tsx";
export * from "./components/ModalHelpOverlay.tsx";
export * from "./components/markdownBlocks.ts";
export * from "./components/markdownSyntax.ts";
export * from "./components/modalHelp.ts";
export * from "./components/modalStack.ts";
export * from "./components/Notification.tsx";
export * from "./components/Panel.tsx";
export * from "./components/ProgressModal.tsx";
export * from "./components/RunningText.tsx";
export * from "./components/ScrollableContent.tsx";
export * from "./components/ScrollableList.tsx";
export * from "./components/SearchHeader.tsx";
export * from "./components/Selectable.tsx";
export * from "./components/SelectionMarker.tsx";
export * from "./components/SortModal.tsx";
export * from "./components/StatusBar.tsx";
export * from "./components/selectionCopy";
export * from "./components/Text.tsx";
export * from "./components/ThemePicker.tsx";
export * from "./components/ThemePickerModal.tsx";
export * from "./components/utils/focusSoon";
export * from "./components/utils/gitlabHtml.ts";
export * from "./components/utils/virtualScroll";
export * from "./components/VerdictModal.tsx";
export * from "./theme/animationColors.ts";
export * from "./theme/colors.ts";
export * from "./theme/terminal-theme";
export * from "./theme/theme";
export type {
	ActionTarget,
	AgentGroup,
	AgentSessionInfo,
	App,
	ChangeRequest,
	DependencyRef,
	Issue,
	IssueComment,
	IssueScope,
	Job,
	KubernetesClusterStatus,
	Provider,
	ProviderType,
	RuntimeState,
	RuntimeStatus,
	ScriptParameter,
	SshHost,
	TableRow,
	TestCase,
	TestSuite,
	WorktreeInfo,
} from "./types.ts";
export * from "./views/ActionTargetPickerView.tsx";
export * from "./views/AddRepositoryModal.tsx";
export * from "./views/AgentSpaceView.tsx";
export * from "./views/AppDetailView.tsx";
export * from "./views/AssigneePickerModal.tsx";
export * from "./views/annotations.tsx";
export * from "./views/ansiToStyledText.ts";
export * from "./views/BranchCreateModal.tsx";
export * from "./views/BranchSelectorView.tsx";
export * from "./views/ChangeRequestDetailView.tsx";
export * from "./views/ChangeRequestView.tsx";
export * from "./views/CloseReasonModal.tsx";
export * from "./views/CommentModal.tsx";
export * from "./views/ConfirmDialog.tsx";
export * from "./views/ConnectProviderModal.tsx";
export * from "./views/CrAiReviewOverlay.tsx";
export * from "./views/DependencyTreeView.tsx";
export * from "./views/DetailSection.tsx";
export * from "./views/DiffReviewView.tsx";
export * from "./views/DiscussionsView.tsx";
export * from "./views/EditorPickerView.tsx";
export * from "./views/FrontmatterModal.tsx";
export * from "./views/HelpView.tsx";
export * from "./views/IssueDetailView.tsx";
export * from "./views/IssueScopeModal.tsx";
export * from "./views/IssueView.tsx";
export * from "./views/JobsDetailView.tsx";
export * from "./views/KubernetesClusterView.tsx";
export * from "./views/LabelPickerModal.tsx";
export * from "./views/LogAiOverlay.tsx";
export * from "./views/LogModal.tsx";
export * from "./views/MarkdownModal.tsx";
export * from "./views/MarkdownReviewView.tsx";
export * from "./views/ModalTabs.tsx";
export * from "./views/PassphraseModal.tsx";
export * from "./views/ProfilePickerView.tsx";
export * from "./views/ProgressAnimationDemo.tsx";
export * from "./views/PropertiesList.tsx";
export * from "./views/ProvidersView.tsx";
export * from "./views/ReferencesView.tsx";
export * from "./views/ResourceTimelineCharts.tsx";
export * from "./views/SshHostPickerView.tsx";
export * from "./views/statusUtils.ts";
export * from "./views/Table.tsx";
export * from "./views/TaskAddModal.tsx";
export * from "./views/TaskArgsModal.tsx";
export * from "./views/TestDetailModal.tsx";
export * from "./views/TestResultsDetailView.tsx";
export * from "./views/TextTransitionAnimation.tsx";
export * from "./views/ThemePickerView.tsx";
export * from "./views/TimelineView.tsx";
export * from "./views/types.ts";
export * from "./views/WorkItemCard.tsx";
export * from "./views/WorktreeManagerModal.tsx";
