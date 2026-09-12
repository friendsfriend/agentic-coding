// Export ANSI escape sequence utilities
export { ansiToStyledText, stripAnsi } from "./ansiToStyledText";
export type { CatppuccinColor, UIColor } from "./colors";
// Export color scheme
export { colors, SCROLLBAR_OPTIONS, uiColors } from "./colors";
export type { ActionTargetPickerProps } from "./components/ActionTargetPickerView";
export {
	ActionTargetPickerView,
	formatActionTargetLabel,
} from "./components/ActionTargetPickerView";
export type {
	AddRepositoryModalProps,
	AddRepositoryStep,
	FindRepoMode,
} from "./components/AddRepositoryModal";
export { AddRepositoryModal } from "./components/AddRepositoryModal";
export type { AgentSpaceViewProps } from "./components/AgentSpaceView";
export { AgentSpaceView, getSelectableRows } from "./components/AgentSpaceView";
export type {
	AnimatedStatusTextProps,
	StatusAnimationIntent,
	StatusAnimationModel,
} from "./components/AnimatedStatusText";
export {
	AnimatedStatusText,
	statusAnimationIntentForOperation,
	statusAnimationIntentForText,
	statusAnimationModel,
} from "./components/AnimatedStatusText";
export type { AppDetailKind } from "./components/AppDetailView";
export { AppDetailView } from "./components/AppDetailView";
export type { AssigneePickerModalProps } from "./components/AssigneePickerModal";
export { AssigneePickerModal } from "./components/AssigneePickerModal";
export type { BadgeProps } from "./components/Badge";
export { Badge } from "./components/Badge";
export type { BranchCreateModalProps } from "./components/BranchCreateModal";
export { BranchCreateModal } from "./components/BranchCreateModal";
export type {
	BranchInfo,
	BranchSelectorProps,
} from "./components/BranchSelectorView";
export { BranchSelectorView } from "./components/BranchSelectorView";
export type { CenteredStateProps } from "./components/CenteredState";
export { CenteredState } from "./components/CenteredState";
export { ChangedFilesView } from "./components/ChangedFilesView";
export { ChangeRequestDetailView } from "./components/ChangeRequestDetailView";
export { ChangeRequestView } from "./components/ChangeRequestView";
export { CloseReasonModal } from "./components/CloseReasonModal";
export type { CommentModalProps } from "./components/CommentModal";
export { CommentModal } from "./components/CommentModal";
export type { ConfirmDialogProps } from "./components/ConfirmDialog";
export { ConfirmDialog } from "./components/ConfirmDialog";
export type {
	ConnectProviderModalProps,
	ConnectProviderStep,
} from "./components/ConnectProviderModal";
export { ConnectProviderModal } from "./components/ConnectProviderModal";
export type {
	ContentFrameProps,
	ContentPanelProps,
	ContentStackProps,
	GridColumn,
	GridLayoutProps,
} from "./components/ContentStack";
export {
	ContentFrame,
	ContentPanel,
	ContentStack,
	GridLayout,
} from "./components/ContentStack";
export type { CrAiReviewOverlayProps } from "./components/CrAiReviewOverlay";
export { CrAiReviewOverlay } from "./components/CrAiReviewOverlay";
export type {
	DependencyNode,
	DependencyTreeViewProps,
} from "./components/DependencyTreeView";
export {
	buildDependencyTree,
	DependencyTreeView,
	expandNode,
} from "./components/DependencyTreeView";
export type { DetailSectionProps } from "./components/DetailSection";
export { DetailSection } from "./components/DetailSection";
export { DiffViewModal } from "./components/DiffViewModal";
export { DiscussionsView } from "./components/DiscussionsView";
export type {
	EditorChoice,
	EditorOption,
	EditorPickerViewProps,
} from "./components/EditorPickerView";
export {
	EDITOR_OPTIONS,
	EditorPickerView,
} from "./components/EditorPickerView";
export type { ErrorDialogProps } from "./components/ErrorDialog";
export { ErrorDialog } from "./components/ErrorDialog";
export type {
	FilterModalProps,
	FilterParameterOption,
	FilterValueOption,
} from "./components/FilterModal";
export { FilterModal } from "./components/FilterModal";
export type { FilterStatusBarProps } from "./components/FilterStatusBar";
export { FilterStatusBar } from "./components/FilterStatusBar";
export type { GenericModalProps } from "./components/GenericModal";
export { GenericModal } from "./components/GenericModal";
export type { HeaderProps } from "./components/Header";
export { Header } from "./components/Header";
export type { HelpEntry, HelpTextProps } from "./components/HelpText";
export {
	formatHelpText,
	formatHelpTextLines,
	HelpText,
} from "./components/HelpText";
export type { HelpSection, HelpViewProps } from "./components/HelpView";
export { HelpView } from "./components/HelpView";
export type { Highlight, HighlightedTextProps } from "./components/Highlight";
export {
	HighlightedText,
	highlightColor,
	highlightForIndex,
} from "./components/Highlight";
export type {
	InlineProgressAnimationProps,
	InlineProgressHighlights,
} from "./components/InlineProgressAnimation";
export {
	DEFAULT_INLINE_PROGRESS_HIGHLIGHTS,
	InlineProgressAnimation,
} from "./components/InlineProgressAnimation";
export { IssueDetailView } from "./components/IssueDetailView";
export type { IssueScopeOption } from "./components/IssueScopeModal";
export {
	ISSUE_SCOPE_OPTIONS,
	IssueScopeModal,
} from "./components/IssueScopeModal";
export { IssueView } from "./components/IssueView";
export { JobsDetailView } from "./components/JobsDetailView";
export type { KubernetesClusterViewProps } from "./components/KubernetesClusterView";
export {
	KubernetesClusterView,
	PanelBox,
} from "./components/KubernetesClusterView";
export type { LabelPickerModalProps } from "./components/LabelPickerModal";
export { LabelPickerModal } from "./components/LabelPickerModal";
export type { LayoutProps } from "./components/Layout";
export { Layout } from "./components/Layout";
export type { ListViewModalProps } from "./components/ListViewModal";
export { ListViewModal } from "./components/ListViewModal";
export type { LogAiOverlayProps } from "./components/LogAiOverlay";
export { LogAiOverlay } from "./components/LogAiOverlay";
export type { LogModalProps } from "./components/LogModal";
export { LogModal } from "./components/LogModal";
export type { LogViewProps } from "./components/LogView";
export { LogView } from "./components/LogView";
export { MarkdownModal } from "./components/MarkdownModal";
export type { MatchedTextProps } from "./components/MatchedText";
export { MatchedText, splitMatches } from "./components/MatchedText";
export type { ModalTabItem, ModalTabsProps } from "./components/ModalTabs";
export { ModalTabs } from "./components/ModalTabs";
export type { PassphraseModalProps } from "./components/PassphraseModal";
export { PassphraseModal } from "./components/PassphraseModal";
export type { ProfilePickerProps } from "./components/ProfilePickerView";
export {
	formatProfileLabel,
	ProfilePickerView,
} from "./components/ProfilePickerView";
export {
	PROGRESS_ANIMATION_DEMO_LINES,
	ProgressAnimationDemo,
} from "./components/ProgressAnimationDemo";
export type {
	PropertiesListProps,
	PropertyBadge,
	PropertyBadgeListValue,
	PropertyHighlight,
	PropertyLayout,
	PropertyRow,
	PropertyValue,
} from "./components/PropertiesList";
export { PropertiesList, propertyBadges } from "./components/PropertiesList";
export { ProvidersView } from "./components/ProvidersView";
export { ReferencesView } from "./components/ReferencesView";
export type {
	ResourceTimelineChartsProps,
	TimelineMetric,
} from "./components/ResourceTimelineCharts";
export { ResourceTimelineCharts } from "./components/ResourceTimelineCharts";
export type { RunningTextProps } from "./components/RunningText";
export { RunningText, runningTextFrame } from "./components/RunningText";
export type {
	ScrollAxis,
	ScrollableContentProps,
} from "./components/ScrollableContent";
export {
	allowsKeyboardAxis,
	ScrollableContent,
} from "./components/ScrollableContent";
export type { ScrollableListProps } from "./components/ScrollableList";
// Export universal scrollable list primitive
export {
	LAYOUT_CHROME_LINES,
	ScrollableList,
} from "./components/ScrollableList";
export type { SearchHeaderProps } from "./components/SearchHeader";
export { SearchHeader } from "./components/SearchHeader";
export type {
	SortDirection,
	SortModalProps,
	SortParameterOption,
} from "./components/SortModal";
export { SortModal } from "./components/SortModal";
export type { SshHostPickerViewProps } from "./components/SshHostPickerView";
export { SshHostPickerView } from "./components/SshHostPickerView";
export type { StatusBarProps } from "./components/StatusBar";
export { StatusBar } from "./components/StatusBar";
export type { TableColumn, TableProps, TableTab } from "./components/Table";
export {
	InfrastructureTable,
	RepositoryTable,
	Table,
	TaskTable,
} from "./components/Table";
export type { TaskAddModalProps } from "./components/TaskAddModal";
export { TaskAddModal } from "./components/TaskAddModal";
export type { TaskArgsModalProps } from "./components/TaskArgsModal";
export { TaskArgsModal } from "./components/TaskArgsModal";
export { TestDetailModal } from "./components/TestDetailModal";
export { TestResultsDetailView } from "./components/TestResultsDetailView";
export type { TextTransitionAnimationProps } from "./components/TextTransitionAnimation";
export { TextTransitionAnimation } from "./components/TextTransitionAnimation";
export type { ThemePickerViewProps } from "./components/ThemePickerView";
export { ThemePickerView } from "./components/ThemePickerView";
export {
	commentToItem,
	TimelineView,
	toTimelineItems,
} from "./components/TimelineView";
export type { WorkItemCardProps } from "./components/WorkItemCard";
export { WorkItemCard } from "./components/WorkItemCard";
export type { WorktreeManagerModalProps } from "./components/WorktreeManagerModal";
export { WorktreeManagerModal } from "./components/WorktreeManagerModal";

// Export markdown syntax style helper
export { getMarkdownSyntaxStyle } from "./markdownSyntax";
export type { SelectionMouseUpHandler } from "./selectionCopy";
export { setGlobalSelectionMouseUpHandler } from "./selectionCopy";
export type { StatusStyle } from "./statusUtils";
// Export status utilities
export {
	formatGitStatus,
	formatRuntimeStatus,
	formatShortDate,
	formatStatus,
	getGitStatusStyle,
	getIssueStateColor,
	getPipelineStatusColor,
	getStatusStyle,
	runtimeState,
	runtimeStatusText,
	truncateText,
} from "./statusUtils";
export type { ThemeJson } from "./theme";
export {
	getActiveThemeName,
	isThemeJson,
	setActiveThemeName,
	setCustomThemes,
	setSystemTheme,
	themeColorForTheme,
	themeNames,
} from "./theme";
// Export HTML-to-text utility
export { containsHtml, gitlabHtmlToMarkdown } from "./utils/gitlabHtml";
export type {
	VirtualScrollOptions,
	VirtualScrollResult,
	VisibleItem,
} from "./utils/virtualScroll";
// Export virtual scroll utility
export { calculateVisibleItems } from "./utils/virtualScroll";
