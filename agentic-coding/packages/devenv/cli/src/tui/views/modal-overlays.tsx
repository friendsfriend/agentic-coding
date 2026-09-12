import {
	ActionTargetPickerView,
	AddRepositoryModal,
	AgentSpaceView,
	AnimatedStatusText,
	AssigneePickerModal,
	BranchCreateModal,
	BranchSelectorView,
	CloseReasonModal,
	CommentModal,
	ConfirmDialog,
	ConnectProviderModal,
	CrAiReviewOverlay,
	DiffViewModal,
	EditorPickerView,
	ErrorDialog,
	FilterModal,
	HelpView,
	LabelPickerModal,
	LogModal,
	MarkdownModal,
	PassphraseModal,
	ProfilePickerView,
	ProvidersView,
	SortModal,
	SshHostPickerView,
	TaskAddModal,
	TaskArgsModal,
	TestDetailModal,
	ThemePickerView,
	themeNames,
	uiColors,
	WorktreeManagerModal,
} from "@devenv/ui";
import { RGBA, TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { guides as allGuides, getGuide } from "../guides";
import { ActionRunModal } from "./action-run-modal";
import { FirstStepsView } from "./first-steps-view";
import type { ModalOverlaysProps } from "./types";

export function ModalOverlays(props: ModalOverlaysProps) {
	const {
		appStore,
		issueStore,
		logStore,
		changeRequestStore,
		providerStore,
		uiStore,
		agentStore,
	} = props.stores;
	const { dockerActions, crActions, logActions, issueActions, helpActions } =
		props.actions;

	return (
		<>
			<Show when={appStore.activeModal() === "actions"}>
				<ActionRunModal
					store={props.stores.actionRunStore}
					onClose={() => appStore.popModal("actions")}
				/>
			</Show>
			<Show when={appStore.viewMode() === "providers"}>
				<ProvidersView
					providers={providerStore.providers()}
					loading={providerStore.providersLoading()}
					error={providerStore.providersError()}
					selectedProviderIndex={providerStore.selectedProviderIndex()}
					onClose={() => {
						appStore.setViewMode("table");
						providerStore.setProviders([]);
						providerStore.setProvidersError("");
					}}
				/>
			</Show>

			<Show
				when={
					appStore.showFirstSteps() &&
					appStore.viewMode() === "table" &&
					!providerStore.showConnectProviderModal() &&
					!providerStore.showAddRepositoryModal() &&
					!uiStore.showMarkdownModal()
				}
			>
				<FirstStepsView appStore={appStore} providerStore={providerStore} />
			</Show>
			<Show when={uiStore.showThemePicker()}>
				<ThemePickerView
					selectedIndex={uiStore.themePickerSelectedIndex()}
					activeTheme={uiStore.activeThemeName()}
					filterQuery={uiStore.themePickerFilterQuery()}
					filterActive={uiStore.themePickerFilterActive()}
					themes={
						uiStore.themePickerFilterQuery()
							? themeNames.filter((name) =>
									name
										.toLowerCase()
										.includes(uiStore.themePickerFilterQuery().toLowerCase()),
								)
							: themeNames
					}
				/>
			</Show>
			<Show when={uiStore.showMarkdownModal()}>
				<MarkdownModal
					title={uiStore.markdownModalTitle()}
					content={uiStore.markdownModalContent()}
					hideTitle={uiStore.markdownModalTitle() === ""}
					onScrollBoxReady={(scrollBox) => {
						uiStore.markdownModalScrollBoxRef = scrollBox;
					}}
				/>
			</Show>

			<Show when={appStore.showTableFilterModal()}>
				<FilterModal
					parameters={appStore.tableFilterParameters()}
					selectedParameterIndex={appStore.tableFilterParameterIndex()}
					selectedValueIndex={appStore.tableFilterValueIndex()}
					focusedPane={appStore.tableFilterFocusedPane()}
					activeFilters={appStore.tableFilters()}
				/>
			</Show>

			<Show when={appStore.showTableSortModal()}>
				<SortModal
					parameters={appStore.tableSortRules()}
					selectedIndex={appStore.tableSortSelectedIndex()}
				/>
			</Show>

			<Show when={appStore.viewMode() === "help"}>
				{(() => {
					const helpData = helpActions.getHelpContent();
					const sections = () =>
						appStore.helpAllContexts()
							? helpActions.getHelpContent(true).sections
							: helpData.sections;
					const title = () =>
						appStore.helpAllContexts() ? "All Contexts" : helpData.title;
					const guideEntries = () =>
						allGuides.map((g) => ({
							key: g.key,
							title: g.title,
							description: g.description,
							category: g.category,
						}));
					return (
						<HelpView
							sections={sections()}
							viewTitle={title()}
							onClose={helpActions.closeHelp}
							searchActive={appStore.helpSearchActive()}
							searchQuery={appStore.helpSearchQuery()}
							onSearchChange={(q) => appStore.setHelpSearchQuery(q)}
							runningTextEnabled={uiStore.runningTextEnabled()}
							runningTextOffset={uiStore.runningTextOffset()}
							allContexts={appStore.helpAllContexts()}
							onScopeToggle={(v) => appStore.setHelpAllContexts(v)}
							activeTab={appStore.helpActiveTab()}
							onTabChange={(tab) => {
								appStore.setHelpActiveTab(tab);
								appStore.setHelpSearchActive(false);
								appStore.setHelpSearchQuery("");
								appStore.setHelpGuideIndex(tab === "guides" ? 0 : -1);
							}}
							selectedGuideIndex={appStore.helpGuideIndex()}
							guides={guideEntries()}
							onKeybindScrollBoxReady={(scrollBox) => {
								uiStore.helpKeybindScrollBoxRef = scrollBox;
							}}
							onGuideScrollBoxReady={(scrollBox) => {
								uiStore.helpGuideScrollBoxRef = scrollBox;
							}}
							onGuideSelect={async (key) => {
								const guide = getGuide(key);
								if (guide) {
									const content = await guide.import();
									helpActions.closeHelp();
									uiStore.setMarkdownModalReturnToHelp(true);
									uiStore.setMarkdownModalTitle("");
									uiStore.setMarkdownModalContent(content);
									uiStore.setShowMarkdownModal(true);
								}
							}}
						/>
					);
				})()}
			</Show>

			<Show when={issueStore.showIssueListFilterModal()}>
				<FilterModal
					parameters={issueStore.issueListFilterParameters()}
					selectedParameterIndex={issueStore.issueListFilterParameterIndex()}
					selectedValueIndex={issueStore.issueListFilterValueIndex()}
					focusedPane={issueStore.issueListFilterFocusedPane()}
					activeFilters={issueStore.issueListFilters()}
				/>
			</Show>

			<Show when={issueStore.showIssueListSortModal()}>
				<SortModal
					parameters={issueStore.issueListSortRules()}
					selectedIndex={issueStore.issueListSortSelectedIndex()}
				/>
			</Show>

			<Show when={changeRequestStore.showCrListFilterModal()}>
				<FilterModal
					parameters={changeRequestStore.crListFilterParameters()}
					selectedParameterIndex={changeRequestStore.crListFilterParameterIndex()}
					selectedValueIndex={changeRequestStore.crListFilterValueIndex()}
					focusedPane={changeRequestStore.crListFilterFocusedPane()}
					activeFilters={changeRequestStore.crListFilters()}
				/>
			</Show>

			<Show when={changeRequestStore.showCrListSortModal()}>
				<SortModal
					parameters={changeRequestStore.crListSortRules()}
					selectedIndex={changeRequestStore.crListSortSelectedIndex()}
				/>
			</Show>

			<Show when={changeRequestStore.showListFilterModal()}>
				<FilterModal
					parameters={changeRequestStore.listFilterParameters()}
					selectedParameterIndex={changeRequestStore.listFilterParameterIndex()}
					selectedValueIndex={changeRequestStore.listFilterValueIndex()}
					focusedPane={changeRequestStore.listFilterFocusedPane()}
					activeFilters={changeRequestStore.currentListFilters()}
				/>
			</Show>

			<Show when={changeRequestStore.showListSortModal()}>
				<SortModal
					parameters={changeRequestStore.currentListSortRules()}
					selectedIndex={changeRequestStore.listSortSelectedIndex()}
				/>
			</Show>

			<Show when={issueStore.showReferenceFilterModal()}>
				<FilterModal
					parameters={issueStore.referenceFilterParameters()}
					selectedParameterIndex={issueStore.referenceFilterParameterIndex()}
					selectedValueIndex={issueStore.referenceFilterValueIndex()}
					focusedPane={issueStore.referenceFilterFocusedPane()}
					activeFilters={issueStore.referenceFilters()}
				/>
			</Show>

			<Show when={issueStore.showReferenceSortModal()}>
				<SortModal
					parameters={issueStore.referenceSortRules()}
					selectedIndex={issueStore.referenceSortSelectedIndex()}
				/>
			</Show>

			<Show when={issueStore.showCommentModal()}>
				<CommentModal
					text={issueStore.commentText()}
					submitting={issueStore.issueSubmitting()}
					error={issueStore.issueSubmitError()}
					onInput={(text) => issueStore.setCommentText(text)}
					onSubmit={() => issueActions.addComment()}
					onCancel={() => {
						issueStore.setShowCommentModal(false);
						issueStore.setCommentText("");
					}}
				/>
			</Show>

			<Show when={issueStore.showCloseReasonModal()}>
				<CloseReasonModal
					selectedIndex={issueStore.closeReasonIndex()}
					onSelect={(idx) => issueStore.setCloseReasonIndex(idx)}
					onSubmit={(reason: string) => {
						const { issueActions } = props.actions;
						issueStore.setShowCloseReasonModal(false);
						const issue = issueStore.selectedIssue();
						if (issue) {
							issueActions.closeIssue(issue.iid, reason);
						}
					}}
					onCancel={() => issueStore.setShowCloseReasonModal(false)}
				/>
			</Show>

			<Show when={issueStore.showLabelPicker()}>
				<LabelPickerModal
					labels={issueStore.availableLabels()}
					selectedLabels={issueStore.labelPickerSelectedLabels()}
					selectedIndex={issueStore.labelPickerIndex()}
					loading={issueStore.issueLoading()}
					onSelect={(idx) => issueStore.setLabelPickerIndex(idx)}
					onToggle={(label) => {
						const selected = issueStore.labelPickerSelectedLabels();
						issueStore.setLabelPickerSelectedLabels(
							selected.includes(label)
								? selected.filter((item) => item !== label)
								: [...selected, label],
						);
					}}
					onConfirm={() => {
						const issue = issueStore.selectedIssue();
						if (issue)
							props.actions.issueActions.setIssueLabels(
								issue.iid,
								issueStore.labelPickerSelectedLabels(),
							);
					}}
					onCancel={() => issueStore.setShowLabelPicker(false)}
				/>
			</Show>

			<Show when={issueStore.showAssigneePicker()}>
				<AssigneePickerModal
					collaborators={issueStore.availableCollaborators()}
					currentAssignee={
						issueStore.selectedIssue()?.assignees?.[0]?.username ?? ""
					}
					selectedIndex={issueStore.assigneePickerIndex()}
					loading={issueStore.issueLoading()}
					onSelect={(idx) => issueStore.setAssigneePickerIndex(idx)}
					onPick={() => {}}
					onCancel={() => issueStore.setShowAssigneePicker(false)}
				/>
			</Show>

			<Show when={appStore.viewMode() === "sshPicker"}>
				<SshHostPickerView
					hosts={agentStore.sshHosts()}
					selectedIndex={agentStore.selectedSshIndex()}
					searchQuery={agentStore.sshSearchQuery()}
					filterQuery={agentStore.sshSearchQuery()}
					filterActive={agentStore.sshFilterActive()}
					onFilterChange={(q) => {
						agentStore.setSshSearchQuery(q);
						agentStore.setSelectedSshIndex(0);
					}}
				/>
			</Show>

			<Show
				when={
					uiStore.showPassphraseModal() &&
					uiStore.pendingSshHost()?.identityFile
				}
			>
				<PassphraseModal
					identityFile={uiStore.pendingSshHost()?.identityFile ?? ""}
					passphraseText={uiStore.passphraseText()}
					error={uiStore.passphraseError()}
					runningTextEnabled={uiStore.runningTextEnabled()}
					runningTextOffset={uiStore.runningTextOffset()}
				/>
			</Show>

			<Show when={appStore.viewMode() === "agentView"}>
				<AgentSpaceView
					piAgentGroups={agentStore.piAgentGroups()}
					sessionsLoading={agentStore.agentSessionsLoading()}
					selectedIndex={agentStore.selectedAgentItemIndex()}
					searchQuery={agentStore.agentSearchQuery()}
					filterQuery={agentStore.agentSearchQuery()}
					filterActive={agentStore.agentFilterActive()}
					onFilterChange={(q) => {
						agentStore.setAgentSearchQuery(q);
						agentStore.setSelectedAgentItemIndex(0);
					}}
				/>
			</Show>

			<Show when={providerStore.showConnectProviderModal()}>
				<ConnectProviderModal
					step={providerStore.connectProviderStep()}
					provider={providerStore.connectProviderType()}
					selectedProviderIndex={providerStore.connectProviderIndex()}
					nameText={providerStore.connectProviderName()}
					usernameText={providerStore.connectProviderUsername()}
					tokenText={providerStore.connectProviderToken()}
					error={providerStore.connectProviderError()}
					success={providerStore.connectProviderSuccess()}
					editMode={providerStore.connectProviderEditMode()}
				/>
			</Show>

			<Show when={providerStore.showAddRepositoryModal()}>
				<AddRepositoryModal
					step={providerStore.addRepositoryStep()}
					providers={providerStore.addRepositoryProviders()}
					selectedProviderIndex={providerStore.addRepositorySelectedProviderIndex()}
					searchQuery={providerStore.addRepositorySearchQuery()}
					searchResults={providerStore.addRepositorySearchResults()}
					selectedResultIndex={providerStore.addRepositorySelectedResultIndex()}
					manualUrl={providerStore.addRepositoryManualUrl()}
					findRepoMode={providerStore.addRepositoryFindRepoMode()}
					findRepoModeIndex={providerStore.addRepositoryFindRepoModeIndex()}
					repositoryName={providerStore.addRepositoryName()}
					branches={providerStore.addRepositoryBranches()}
					selectedBranchIndex={providerStore.addRepositorySelectedBranchIndex()}
					branchFilterQuery={providerStore.addRepositoryBranchFilter()}
					loading={providerStore.addRepositoryLoading()}
					error={providerStore.addRepositoryError()}
					destinationType={providerStore.addRepositoryDestinationType()}
					destinationTypeIndex={providerStore.addRepositoryDestinationTypeIndex()}
				/>
			</Show>

			<Show when={uiStore.showWorktreeManagerModal()}>
				<WorktreeManagerModal
					appName={
						uiStore.worktreeManagerAppId()
							? (appStore
									.apps()
									.find((a) => a.ident === uiStore.worktreeManagerAppId())
									?.displayName ??
								uiStore.worktreeManagerAppId() ??
								"")
							: ""
					}
					worktrees={uiStore.worktreeManagerWorktrees()}
					selectedIndex={uiStore.worktreeManagerSelectedIndex()}
				/>
			</Show>

			<Show when={uiStore.showBranchSelector()}>
				<BranchSelectorView
					branches={uiStore.filteredBranches()}
					currentBranch={uiStore.targetAppForBranch()?.branch || ""}
					selectedIndex={uiStore.branchSelectorIndex()}
					appName={uiStore.targetAppForBranch()?.displayName || ""}
					loading={uiStore.branchesLoading()}
					filterQuery={uiStore.branchFilterQuery()}
					filterActive={uiStore.branchFilterActive()}
					worktreeCreateMode={uiStore.branchSelectorWorktreeCreateMode()}
					onFilterChange={(query) => {
						uiStore.setBranchFilterQuery(query);
						uiStore.setBranchSelectorIndex(0);
					}}
				/>
			</Show>

			<Show when={uiStore.showCreateBranchModal()}>
				<BranchCreateModal
					branchName={uiStore.createBranchName()}
					onBranchNameChange={(value) => uiStore.setCreateBranchName(value)}
				/>
			</Show>

			<Show when={uiStore.showErrorDialog()}>
				<ErrorDialog
					title={uiStore.errorDialogTitle()}
					message={uiStore.errorDialogMessage()}
					onClose={() => uiStore.setShowErrorDialog(false)}
				/>
			</Show>

			<Show when={uiStore.showConfirmDialog()}>
				<ConfirmDialog
					title={uiStore.confirmDialogTitle()}
					message={uiStore.confirmDialogMessage()}
				/>
			</Show>

			<Show when={uiStore.showProfilePicker()}>
				<ProfilePickerView
					profiles={uiStore.profilePickerProfiles()}
					hasDockerfile={uiStore.profilePickerHasDockerfile()}
					selectedIndex={uiStore.profilePickerSelectedIndex()}
					onSelect={uiStore.setProfilePickerSelectedIndex}
					onSubmit={(profile) => {
						uiStore.setShowProfilePicker(false);
						const ident = uiStore.profilePickerAppIdent();
						if (ident) {
							// Try to find an application first, otherwise look for an infra service.
							const appOrSvc =
								appStore.apps().find((a) => a.ident === ident) ||
								appStore.infraServices().find((s) => s.ident === ident);
							if (appOrSvc) {
								void dockerActions.performDockerOperation(
									"start",
									appOrSvc,
									profile === "default (no profile)" ? "" : profile,
								);
							}
						}
					}}
					onCancel={() => uiStore.setShowProfilePicker(false)}
					loading={uiStore.profilePickerLoading()}
				/>
			</Show>

			<Show when={uiStore.showActionTargetPicker()}>
				<ActionTargetPickerView
					title={`Select ${uiStore.actionTargetPickerAction()} target`}
					targets={uiStore.actionTargetPickerTargets()}
					selectedIndex={uiStore.actionTargetPickerSelectedIndex()}
					loading={uiStore.actionTargetPickerLoading()}
				/>
			</Show>

			<Show when={uiStore.showEditorPicker()}>
				<EditorPickerView
					selectedIndex={uiStore.editorPickerSelectedIndex()}
					options={uiStore.editorPickerOptions()}
				/>
			</Show>

			<Show when={uiStore.showTaskArgsModal()}>
				<TaskArgsModal
					taskName={
						appStore.tableFilteredApps()[appStore.selectedIndex()]
							?.displayName || ""
					}
					parameters={uiStore.taskArgsParameters()}
					values={uiStore.scriptArgValues()}
					selectedIndex={uiStore.taskArgsSelectedIndex()}
					selectedValueIndex={uiStore.taskArgsSelectedValueIndex()}
					focusedPane={uiStore.taskArgsFocusedPane()}
					editing={uiStore.taskArgsEditing()}
					historyIndex={uiStore.taskArgsHistoryCursor()}
					historyTotal={uiStore.taskArgsHistoryForCurrent().length}
					error={uiStore.taskArgsError()}
				/>
			</Show>

			<Show when={uiStore.showTaskAddModal()}>
				<TaskAddModal
					mode={uiStore.taskAddMode()}
					targetPath={uiStore.taskAddTargetPath()}
					sourcePath={uiStore.taskAddSourcePath()}
					selectedField={uiStore.taskAddSelectedField()}
					error={uiStore.taskAddError()}
				/>
			</Show>

			<Show when={uiStore.showLoadingModal()}>
				<box
					position="absolute"
					left={0}
					top={0}
					width={props.dimensions.width}
					height={props.dimensions.height}
					flexDirection="column"
					justifyContent="center"
					alignItems="center"
					backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
				>
					<box
						border
						borderStyle="rounded"
						borderColor={uiColors.primary}
						style={{
							paddingLeft: 4,
							paddingRight: 4,
							paddingTop: 2,
							paddingBottom: 2,
							backgroundColor: uiColors.bgBase,
							flexDirection: "column",
							alignItems: "center",
							gap: 1,
						}}
					>
						<AnimatedStatusText
							text={uiStore.loadingModalMessage()}
							intent="load"
							backgroundColor={uiColors.bgBase}
						/>
					</box>
				</box>
			</Show>

			<Show
				when={
					changeRequestStore.showDiffModal() &&
					changeRequestStore.currentDiffFile()
				}
			>
				<DiffViewModal
					filePath={
						changeRequestStore.currentDiffFile()?.new_path ||
						changeRequestStore.currentDiffFile()?.old_path ||
						""
					}
					diff={changeRequestStore.currentDiffFile()?.diff ?? ""}
					currentFileIndex={changeRequestStore.selectedChangedFileIndex()}
					totalFiles={changeRequestStore.crChanges().length}
					selectedLine={changeRequestStore.diffModalSelectedLine()}
					visualModeActive={changeRequestStore.diffModalVisualMode()}
					visualModeStart={changeRequestStore.diffModalVisualStart()}
					forceSplitView={changeRequestStore.diffModalForceSplitView()}
					isNewFile={changeRequestStore.currentDiffFile()?.new_file}
					isDeletedFile={changeRequestStore.currentDiffFile()?.deleted_file}
					commentMode={changeRequestStore.showCommentModal()}
					commentText={changeRequestStore.commentText()}
					discussions={changeRequestStore.crDiscussions()}
					currentHeadSHA={
						changeRequestStore.selectedChangeRequest()?.head_pipeline?.sha
					}
					replyModeDiscussionId={changeRequestStore.replyMode()}
					replyText={changeRequestStore.replyText()}
					collapsedThreads={changeRequestStore.collapsedThreads()}
					onSelectedLineChange={changeRequestStore.setDiffModalSelectedLine}
					onScrollBoxReady={(sb) => {
						changeRequestStore.diffModalScrollBoxRef = sb;
					}}
					onReplyToDiscussion={crActions.replyToDiscussion}
					onClose={() => {
						changeRequestStore.setShowDiffModal(false);
						changeRequestStore.setCurrentDiffFile(null);
						changeRequestStore.setDiffModalSelectedLine(0);
						changeRequestStore.setDiffModalVisualMode(false);
						changeRequestStore.setDiffModalVisualStart(0);
						changeRequestStore.setDiffModalForceSplitView(false);
						changeRequestStore.diffModalScrollBoxRef = undefined;

						if (appStore.previousViewMode() === "discussionsView") {
							appStore.setViewMode("discussionsView");
						}
					}}
					onNavigateFile={(direction) => {
						const changes = changeRequestStore.crChanges();
						if (!changes || changes.length === 0) return;

						let newIndex: number;
						if (direction === 1) {
							newIndex =
								(changeRequestStore.selectedChangedFileIndex() + 1) %
								changes.length;
						} else {
							newIndex = changeRequestStore.selectedChangedFileIndex() - 1;
							if (newIndex < 0) newIndex = changes.length - 1;
						}

						changeRequestStore.setSelectedChangedFileIndex(newIndex);
						changeRequestStore.setDiffModalSelectedLine(0);
						changeRequestStore.setCurrentDiffFile(changes[newIndex]);
					}}
				/>
			</Show>

			<Show when={logStore.showLogModal()}>
				<LogModal
					title={logStore.logTitle()}
					logs={logStore.logs()}
					logLines={logStore.logLines()}
					historyLoading={logStore.logHistoryLoading()}
					historyHasMore={logStore.logHistoryHasMore()}
					historyError={logStore.logHistoryError()}
					onScrollBoxReady={(sb) => {
						logStore.logScrollBoxRef = sb;
						// Read the actual scrollTop and viewport height after the first
						// layout pass. stickyScroll has already positioned the viewport at
						// the bottom, so syncLogScroll correctly initialises logScrollTop.
						setTimeout(() => logActions.syncLogScroll(), 0);
					}}
					onClose={logActions.closeLogModal}
					searchMode={logStore.logSearchMode()}
					searchQuery={logStore.logSearchQuery()}
					searchMatchLines={logStore.logSearchMatchLines()}
					searchMatchLinesList={logStore.logSearchMatchLinesList()}
					searchMatchIndex={logStore.logSearchMatchIndex()}
					aiPromptMode={logStore.logAiPromptMode()}
					aiPromptText={logStore.logAiPromptText()}
					aiLoading={logStore.logAiLoading()}
					aiStreaming={logStore.logAiStreaming()}
					aiSummary={logStore.logAiSummary()}
					aiError={logStore.logAiError()}
					aiVisible={logStore.logAiVisible()}
					aiFollowupText={logStore.logAiFollowupText()}
					onAiDismiss={logActions.dismissAiOverlay}
					onAiScrollBoxReady={(sb) => {
						logStore.logAiScrollBoxRef = sb;
					}}
				/>
			</Show>

			<Show when={changeRequestStore.crAiVisible()}>
				<CrAiReviewOverlay
					loading={changeRequestStore.crAiLoading()}
					streaming={changeRequestStore.crAiStreaming()}
					summary={changeRequestStore.crAiSummary()}
					error={changeRequestStore.crAiError()}
					onDismiss={() => changeRequestStore.setCrAiVisible(false)}
					onScrollBoxReady={(sb) => {
						changeRequestStore.crAiScrollBoxRef = sb;
					}}
				/>
			</Show>

			<Show
				when={
					changeRequestStore.showTestDetailModal() &&
					changeRequestStore.selectedTestForDetail()
				}
			>
				{(test) => (
					<TestDetailModal
						test={test()}
						copyStatus={changeRequestStore.testDetailCopyStatus()}
						onCopy={() => {}}
						onClose={() => changeRequestStore.setShowTestDetailModal(false)}
					/>
				)}
			</Show>

			<Show when={uiStore.notification() !== null}>
				{(() => {
					const n = uiStore.notification();
					if (!n) return null;
					const bgColor =
						n.type === "success"
							? uiColors.success
							: n.type === "warning"
								? uiColors.warning
								: n.type === "error"
									? uiColors.error
									: uiColors.info;
					const icon =
						n.type === "success"
							? "✓ "
							: n.type === "warning"
								? "! "
								: n.type === "error"
									? "✗ "
									: "ℹ ";
					return (
						<box
							position="absolute"
							right={2}
							bottom={1}
							paddingLeft={2}
							paddingRight={2}
							paddingTop={0}
							paddingBottom={0}
							backgroundColor={bgColor}
						>
							<text fg={uiColors.bgBase} attributes={TextAttributes.BOLD}>
								{icon}
								{n.message}
							</text>
						</box>
					);
				})()}
			</Show>
		</>
	);
}
