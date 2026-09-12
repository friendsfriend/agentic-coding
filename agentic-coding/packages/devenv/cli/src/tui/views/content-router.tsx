import type { App, ChangeRequest, Issue, IssueScope } from "@devenv/types";
import {
	AppDetailView,
	ChangedFilesView,
	ChangeRequestDetailView,
	ChangeRequestView,
	ContentStack,
	DiscussionsView,
	HelpView,
	InfrastructureTable,
	IssueDetailView,
	IssueView,
	JobsDetailView,
	KubernetesClusterView,
	LAYOUT_CHROME_LINES,
	ProgressAnimationDemo,
	ReferencesView,
	RepositoryTable,
	TaskTable,
	TestResultsDetailView,
	TimelineView,
	uiColors,
} from "@devenv/ui";
import { TextAttributes } from "@opentui/core";
import { createEffect, For, Show } from "solid-js";
import { guides as allGuides, getGuide } from "../guides";
import { ActionsView } from "./actions-view";
import { ShutdownSplash } from "./shutdown-splash";
import { StartupSplash } from "./startup-splash";
import type { ContentRouterProps } from "./types";

export function ContentRouter(props: ContentRouterProps) {
	const {
		appStore,
		issueStore,
		changeRequestStore,
		appDetailStore,
		actionRunStore,
	} = props.stores;
	const {
		helpActions,
		issueActions,
		pipelineActions,
		logActions,
		crActions,
		dockerActions,
		appActions,
	} = props.actions;

	// Fetch once on tab activation — subsequent updates arrive via SSE kubernetes.cluster.refreshed
	createEffect(() => {
		if (
			appStore.activeTab() !== "kubernetes" ||
			appStore.viewMode() !== "table"
		)
			return;
		void dockerActions.refreshKubernetesCluster();
	});

	// ContentStack adds one-line top and bottom gutters around table.
	const TABLE_VIEW_GUTTERS = 2;
	const TAB_BAR_LINES = 3;
	const availableTableLines = Math.max(
		1,
		props.dimensions.height -
			LAYOUT_CHROME_LINES -
			TABLE_VIEW_GUTTERS -
			TAB_BAR_LINES,
	);
	const tableColumns = () =>
		appStore.activeTab() === "scripts"
			? props.scriptColumns
			: appStore.activeTab() === "infrastructure"
				? props.columns.filter(
						(column) => column.key !== "branch" && column.key !== "gitStatus",
					)
				: props.columns;

	const selectedAppSourceType = () => {
		const row = appStore.filteredApps()[appStore.selectedIndex()];
		return row?.rowKind === "app" ? row.sourceType : undefined;
	};
	const listFilterSummary = (filters: Record<string, string[]>) =>
		Object.entries(filters)
			.filter(([, values]) => values.length > 0)
			.map(([key, values]) => `${key}: ${values.join(",")}`)
			.join(" • ");
	const listSortSummary = (
		rules: Array<{ label: string; direction: string }>,
	) => {
		const active = rules.find((rule) => rule.direction !== "none");
		if (!active) return "";
		const dir = active.direction === "asc" ? "↑" : "↓";
		return `${active.label} ${dir}`;
	};
	const tableFilterSummary = () => listFilterSummary(appStore.tableFilters());
	const tableSortSummary = () => listSortSummary(appStore.tableSortRules());

	return (
		<>
			{appStore.viewMode() === "actions" ? (
				<ActionsView store={actionRunStore} />
			) : appStore.viewMode() === "references" ? (
				<ReferencesView
					references={issueStore.referencesFiltered()}
					allReferencesCount={issueStore.references().length}
					selectedIndex={issueStore.selectedReferenceIndex()}
					loading={
						issueStore.linkedChangeRequestsLoading() ||
						issueStore.referencedIssuesLoading()
					}
					error={
						issueStore.linkedChangeRequestsError() ||
						issueStore.referencedIssuesError()
					}
					onClose={() => issueActions.backToIssueDetailFromReferences()}
					activeFilters={issueStore.referenceFilters()}
					sortRules={issueStore.referenceSortRules()}
					runningTextEnabled={props.runningTextEnabled}
					runningTextOffset={props.runningTextOffset}
				/>
			) : appStore.viewMode() === "changeRequestLinkedIssues" ? (
				<IssueView
					issues={changeRequestStore.changeRequestLinkedIssues()}
					selectedIndex={changeRequestStore.selectedChangeRequestLinkedIssueIndex()}
					onSelectedIndexChange={
						changeRequestStore.setSelectedCrLinkedIssueIndex
					}
					runningTextEnabled={props.runningTextEnabled}
					runningTextOffset={props.runningTextOffset}
					loading={changeRequestStore.changeRequestLinkedIssuesLoading()}
					error={changeRequestStore.changeRequestLinkedIssuesError()}
					currentPage={1}
					totalPages={1}
					totalCount={changeRequestStore.changeRequestLinkedIssues().length}
					scope={"all"}
					onSelectIssue={(issue) => void issueActions.showIssueDetail(issue)}
					onClose={() => {
						changeRequestStore.setSelectedCrLinkedIssueIndex(0);
						appStore.setViewMode("changeRequestDetail");
					}}
				/>
			) : appStore.error() && !appStore.loading() ? (
				<box
					style={{
						width: "100%",
						height: "100%",
						justifyContent: "center",
						alignItems: "center",
					}}
				>
					<text style={{ fg: uiColors.error }}>Error: {appStore.error()}</text>
				</box>
			) : (
				<Show
					when={
						appStore.viewMode() === "table" || appStore.viewMode() === "help"
					}
					fallback={
						<Show
							when={appStore.viewMode() === "help"}
							fallback={
								<Show
									when={appStore.viewMode() === "issues"}
									fallback={
										<Show
											when={
												(appStore.viewMode() === "issueDetail" &&
													issueStore.selectedIssue()) ||
												appStore.viewMode() === "issueTimeline"
											}
											fallback={
												<Show
													when={appStore.viewMode() === "changeRequests"}
													fallback={
														<Show
															when={
																appStore.viewMode() === "changeRequestDetail" &&
																changeRequestStore.selectedChangeRequest()
															}
															fallback={
																<Show
																	when={appStore.viewMode() === "changedFiles"}
																	fallback={
																		<Show
																			when={
																				appStore.viewMode() ===
																				"discussionsView"
																			}
																			fallback={
																				<Show
																					when={
																						appStore.viewMode() ===
																						"testResults"
																					}
																					fallback={
																						<Show
																							when={
																								appStore.viewMode() === "jobs"
																							}
																							fallback={
																								<Show
																									when={
																										appStore.viewMode() ===
																											"appDetail" &&
																										appDetailStore.appDetailApp()
																									}
																									fallback={
																										<box
																											style={{
																												width: "100%",
																												height: "100%",
																											}}
																										/>
																									}
																								>
																									<AppDetailView
																										app={
																											appDetailStore.appDetailApp() as App
																										}
																										kind={appDetailStore.appDetailKind()}
																										gitInfo={appDetailStore.appDetailGitInfo()}
																										changeRequests={appDetailStore.appDetailChangeRequests()}
																										logs={appDetailStore.appDetailLogs()}
																										statsHistory={appDetailStore.appDetailStatsHistory()}
																										memHistory={appDetailStore.appDetailMemHistory()}
																										latestStats={appDetailStore.appDetailLatestStats()}
																										loading={appDetailStore.appDetailLoading()}
																										changeRequestsLoading={appDetailStore.appDetailChangeRequestsLoading()}
																										actionTargets={appDetailStore.actionTargets()}
																										actionTargetsLoading={appDetailStore.actionTargetsLoading()}
																										dependencyTreeNodes={appDetailStore.dependencyTreeNodes()}
																										dependencyTreeFocused={appDetailStore.dependencyTreeFocused()}
																										dependencyTreeSelectedIndex={appDetailStore.dependencyTreeSelectedIndex()}
																										onDependencyNodeClick={(
																											node,
																											idx,
																										) => {
																											console.error(
																												`[HANDLER] key=${node.key}`,
																											);
																											appDetailStore.setAppDetailPanelIndex(
																												2,
																											);
																											appDetailStore.setDependencyTreeSelectedIndex(
																												idx,
																											);
																											appDetailStore.setDependencyTreeFocused(
																												true,
																											);
																											appActions.expandDependencyNode(
																												node.key,
																											);
																										}}
																										activePanelIndex={appDetailStore.appDetailPanelIndex()}
																										onInfoScrollBoxReady={(
																											ref,
																										) => {
																											appDetailStore.appDetailScrollBoxRefs[0] =
																												ref;
																										}}
																										onLogsScrollBoxReady={(
																											ref,
																										) => {
																											appDetailStore.appDetailScrollBoxRefs[3] =
																												ref;
																										}}
																									/>
																								</Show>
																							}
																						>
																							<JobsDetailView
																								jobs={changeRequestStore.jobs()}
																								pipelineId={
																									changeRequestStore.currentPipelineId() ||
																									0
																								}
																								loading={changeRequestStore.jobsLoading()}
																								error={changeRequestStore.jobsError()}
																								selectedStageIndex={changeRequestStore.selectedJobStageIndex()}
																								selectedJobIndex={changeRequestStore.selectedJobIndex()}
																								onClose={
																									pipelineActions.backToCRDetail
																								}
																								onViewJobLogs={
																									logActions.loadJobLogs
																								}
																								onRetryJob={
																									pipelineActions.retryJob
																								}
																								onCancelJob={
																									pipelineActions.cancelJob
																								}
																								searchMode={changeRequestStore.jobsSearchMode()}
																								searchQuery={changeRequestStore.jobsSearchQuery()}
																							/>
																						</Show>
																					}
																				>
																					<TestResultsDetailView
																						testSuites={
																							changeRequestStore.crTestSummary()
																								?.test_suites
																						}
																						loading={changeRequestStore.crTestLoading()}
																						error={changeRequestStore.crTestError()}
																						selectedIndex={changeRequestStore.selectedTestIndex()}
																						onClose={() =>
																							appStore.setViewMode(
																								"changeRequestDetail",
																							)
																						}
																						searchMode={changeRequestStore.testSearchMode()}
																						searchQuery={changeRequestStore.testSearchQuery()}
																						testResultsUnsupported={
																							selectedAppSourceType() ===
																							"github"
																						}
																						filterSummary={listFilterSummary(
																							changeRequestStore.currentListFilters(),
																						)}
																						sortSummary={listSortSummary(
																							changeRequestStore.currentListSortRules(),
																						)}
																					/>
																				</Show>
																			}
																		>
																			<DiscussionsView
																				discussions={changeRequestStore.crDiscussions()}
																				selectedIndex={changeRequestStore.selectedDiscussionIndex()}
																				currentHeadSHA={
																					changeRequestStore.selectedChangeRequest()
																						?.head_pipeline?.sha
																				}
																				changes={changeRequestStore.crChanges()}
																				loading={changeRequestStore.crDiscussionsLoading()}
																				error={changeRequestStore.crDiscussionsError()}
																				replyModeDiscussionId={changeRequestStore.replyMode()}
																				replyText={changeRequestStore.replyText()}
																				showOnlyComments={changeRequestStore.discussionsShowOnlyComments()}
																				onClose={() => {
																					changeRequestStore.setSelectedDiscussionIndex(
																						0,
																					);
																					appStore.setViewMode(
																						"changeRequestDetail",
																					);
																				}}
																			/>
																		</Show>
																	}
																>
																	<ChangedFilesView
																		changes={changeRequestStore.changedFilesFiltered()}
																		selectedIndex={changeRequestStore.selectedChangedFileIndex()}
																		loading={changeRequestStore.crChangesLoading()}
																		error={changeRequestStore.crChangesError()}
																		onClose={() => {
																			changeRequestStore.setSelectedChangedFileIndex(
																				0,
																			);
																			appStore.setViewMode(
																				"changeRequestDetail",
																			);
																		}}
																		searchMode={changeRequestStore.changedFilesSearchMode()}
																		searchQuery={changeRequestStore.changedFilesSearchQuery()}
																		filterSummary={listFilterSummary(
																			changeRequestStore.currentListFilters(),
																		)}
																		sortSummary={listSortSummary(
																			changeRequestStore.currentListSortRules(),
																		)}
																	/>
																</Show>
															}
														>
															<ChangeRequestDetailView
																changeRequest={
																	changeRequestStore.selectedChangeRequest() as ChangeRequest
																}
																jobs={changeRequestStore.crJobsForDetail()}
																jobsLoading={changeRequestStore.crJobsForDetailLoading()}
																testSummary={
																	changeRequestStore.crTestSummary() ||
																	undefined
																}
																testLoading={changeRequestStore.crTestLoading()}
																testError={changeRequestStore.crTestError()}
																testResultsUnsupported={
																	selectedAppSourceType() === "github"
																}
																changes={changeRequestStore.crChanges()}
																changesLoading={changeRequestStore.crChangesLoading()}
																changesError={changeRequestStore.crChangesError()}
																discussions={changeRequestStore.crDiscussions()}
																discussionsLoading={changeRequestStore.crDiscussionsLoading()}
																discussionsError={changeRequestStore.crDiscussionsError()}
																linkedIssues={changeRequestStore.changeRequestLinkedIssues()}
																linkedIssuesLoading={changeRequestStore.changeRequestLinkedIssuesLoading()}
																linkedIssuesError={changeRequestStore.changeRequestLinkedIssuesError()}
																activePanelIndex={changeRequestStore.crDetailPanelIndex()}
																runningTextEnabled={props.runningTextEnabled}
																runningTextOffset={props.runningTextOffset}
																onClose={crActions.backToCRList}
																onMetadataScrollBoxReady={(ref) => {
																	changeRequestStore.crDetailScrollBoxRefs[0] =
																		ref;
																}}
																onChangedFilesScrollBoxReady={(ref) => {
																	changeRequestStore.crDetailScrollBoxRefs[2] =
																		ref;
																}}
																onPipelineJobsScrollBoxReady={(ref) => {
																	changeRequestStore.crDetailScrollBoxRefs[3] =
																		ref;
																}}
															/>
														</Show>
													}
												>
													<ChangeRequestView
														changeRequests={changeRequestStore.changeRequests()}
														selectedIndex={changeRequestStore.selectedChangeRequestIndex()}
														onSelectedIndexChange={
															changeRequestStore.setSelectedCRIndex
														}
														onClose={() => {
															appStore.setViewMode("table");
															changeRequestStore.setChangeRequests([]);
															changeRequestStore.setCrError("");
															changeRequestStore.setSelectedCR(null);
															changeRequestStore.setSelectedCRIndex(0);
														}}
														onSelectCR={crActions.showCRDetail}
														loading={changeRequestStore.crLoading()}
														error={changeRequestStore.crError()}
														searchMode={changeRequestStore.crSearchMode()}
														searchQuery={changeRequestStore.crSearchQuery()}
														currentPage={changeRequestStore.currentPage()}
														totalPages={changeRequestStore.totalPages()}
														state={
															changeRequestStore.crListFilters().state?.[0] ??
															"opened"
														}
														sourceType={selectedAppSourceType()}
														filterSummary={listFilterSummary(
															changeRequestStore.crListFilters(),
														)}
														sortSummary={listSortSummary(
															changeRequestStore.crListSortRules(),
														)}
														runningTextEnabled={props.runningTextEnabled}
														runningTextOffset={props.runningTextOffset}
													/>
												</Show>
											}
										>
											<Show when={appStore.viewMode() === "issueDetail"}>
												<IssueDetailView
													issue={issueStore.selectedIssue() as Issue}
													comments={issueStore.issueComments()}
													issueCommentsLoading={issueStore.issueCommentsLoading()}
													error={issueStore.issueDetailError()}
													linkedChangeRequests={issueStore.linkedChangeRequests()}
													linkedChangeRequestsLoading={issueStore.linkedChangeRequestsLoading()}
													linkedChangeRequestsError={issueStore.linkedChangeRequestsError()}
													referencedIssues={issueStore.referencedIssues()}
													referencedIssuesLoading={issueStore.referencedIssuesLoading()}
													referencedIssuesError={issueStore.referencedIssuesError()}
													references={issueStore.references()}
													activePanelIndex={issueStore.issueDetailPanelIndex()}
													onDetailScrollBoxReady={(scrollBox) => {
														issueStore.issueDetailScrollBoxRef = scrollBox;
														issueStore.issueDetailScrollBoxRefs[0] = scrollBox;
													}}
													onCommentsScrollBoxReady={(scrollBox) => {
														issueStore.issueDetailScrollBoxRefs[2] = scrollBox;
													}}
												/>
											</Show>
											<Show when={appStore.viewMode() === "issueTimeline"}>
												<TimelineView
													items={issueStore.issueComments().map((c) => ({
														id: `ic-${c.id}`,
														notes: [
															{
																id: c.id,
																type: "DiscussionNote",
																body: c.body,
																author: c.author,
																created_at: c.created_at,
																updated_at: c.updated_at,
																system: c.system,
															},
														],
													}))}
													selectedIndex={issueStore.selectedTimelineIndex()}
													isIssueTimeline={true}
													title={
														"Timeline (" +
														issueStore.issueComments().length +
														")"
													}
													loading={issueStore.issueCommentsLoading()}
													error={issueStore.issueCommentsError()}
													onClose={() => {
														issueStore.setSelectedTimelineIndex(0);
														appStore.setViewMode("issueDetail");
													}}
												/>
											</Show>
										</Show>
									}
								>
									<IssueView
										issues={issueStore.issues()}
										selectedIndex={issueStore.selectedIssueIndex()}
										onSelectedIndexChange={issueStore.setSelectedIssueIndex}
										loading={issueStore.issueLoading()}
										error={issueStore.issueError()}
										currentPage={issueStore.currentPage()}
										totalPages={issueStore.totalPages()}
										totalCount={issueStore.totalCount()}
										scope={
											(issueStore.issueListFilters().scope?.[0] ??
												"all") as IssueScope
										}
										state={issueStore.issueListFilters().state?.[0] ?? "open"}
										filterSummary={listFilterSummary(
											issueStore.issueListFilters(),
										)}
										sortSummary={listSortSummary(
											issueStore.issueListSortRules(),
										)}
										searchMode={issueStore.issueSearchMode()}
										searchQuery={issueStore.issueSearchQuery()}
										runningTextEnabled={props.runningTextEnabled}
										runningTextOffset={props.runningTextOffset}
										onSelectIssue={(issue) =>
											void issueActions.showIssueDetail(issue)
										}
										onClose={() => {
											appStore.setViewMode("table");
											issueStore.setIssues([]);
											issueStore.setIssueError("");
										}}
									/>
								</Show>
							}
						>
							{(() => {
								const helpData = helpActions.getHelpContent();
								// Recompute sections when scope toggle changes
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
										onGuideSelect={async (key) => {
											const guide = getGuide(key);
											if (guide) {
												const content = await guide.import();
												helpActions.closeHelp();
												props.stores.uiStore.setMarkdownModalReturnToHelp(true);
												props.stores.uiStore.setMarkdownModalTitle("");
												props.stores.uiStore.setMarkdownModalContent(content);
												props.stores.uiStore.setShowMarkdownModal(true);
											}
										}}
									/>
								);
							})()}
						</Show>
					}
				>
					<ContentStack
						items={[
							<box
								style={{
									flexGrow: 1,
									minHeight: 0,
									flexDirection: "column",
									overflow: "hidden",
								}}
							>
								<Show when={appStore.tableTabs().length > 0}>
									<box
										backgroundColor={uiColors.bgBase}
										style={{
											width: "100%",
											flexDirection: "row",
											gap: 1,
										}}
									>
										<For each={appStore.tableTabs()}>
											{(tab) => {
												const isActive = () => appStore.activeTab() === tab.id;
												return (
													<box
														backgroundColor={
															isActive()
																? uiColors.bgSurface0
																: uiColors.bgMantle
														}
														onMouseUp={() => appStore.setActiveTab(tab.id)}
														style={{
															paddingLeft: 2,
															paddingRight: 2,
															height: 3,
															alignItems: "center",
															justifyContent: "center",
														}}
													>
														<text
															fg={
																isActive()
																	? uiColors.primary
																	: uiColors.textMuted
															}
															attributes={
																isActive() ? TextAttributes.BOLD : undefined
															}
														>
															{tab.label}
															{tab.count !== undefined ? ` (${tab.count})` : ""}
														</text>
													</box>
												);
											}}
										</For>
									</box>
								</Show>
								<Show
									when={appStore.activeTab() === "ui-test"}
									fallback={
										<Show
											when={appStore.activeTab() === "kubernetes"}
											fallback={
												<Show
													when={appStore.activeTab() === "scripts"}
													fallback={
														<Show
															when={appStore.activeTab() === "infrastructure"}
															fallback={
																<RepositoryTable
																	apps={appStore.tableFilteredApps()}
																	columns={tableColumns()}
																	selectedIndex={appStore.selectedIndex()}
																	onSelect={appStore.setSelectedIndex}
																	showBorder={true}
																	availableLines={availableTableLines}
																	searchMode={appStore.tableSearchMode()}
																	searchQuery={appStore.tableSearchQuery()}
																	filterSummary={tableFilterSummary()}
																	sortSummary={tableSortSummary()}
																	runningTextEnabled={props.runningTextEnabled}
																	runningTextOffset={props.runningTextOffset}
																/>
															}
														>
															<InfrastructureTable
																apps={appStore.tableFilteredApps()}
																columns={tableColumns()}
																selectedIndex={appStore.selectedIndex()}
																onSelect={appStore.setSelectedIndex}
																showBorder={true}
																availableLines={availableTableLines}
																searchMode={appStore.tableSearchMode()}
																searchQuery={appStore.tableSearchQuery()}
																filterSummary={tableFilterSummary()}
																sortSummary={tableSortSummary()}
																runningTextEnabled={props.runningTextEnabled}
																runningTextOffset={props.runningTextOffset}
															/>
														</Show>
													}
												>
													<TaskTable
														apps={appStore.tableFilteredApps()}
														columns={tableColumns()}
														selectedIndex={appStore.selectedIndex()}
														onSelect={appStore.setSelectedIndex}
														showBorder={true}
														availableLines={availableTableLines}
														searchMode={appStore.tableSearchMode()}
														searchQuery={appStore.tableSearchQuery()}
														filterSummary={tableFilterSummary()}
														sortSummary={tableSortSummary()}
														runningTextEnabled={props.runningTextEnabled}
														runningTextOffset={props.runningTextOffset}
													/>
												</Show>
											}
										>
											<KubernetesClusterView
												status={appStore.kubernetesClusterStatus()}
												loading={appStore.kubernetesClusterLoading()}
												error={appStore.kubernetesClusterError()}
												cpuHistory={appStore.kubernetesCPUHistory()}
												memoryHistory={appStore.kubernetesMemoryHistory()}
												height={availableTableLines}
												activePanelIndex={appStore.kubernetesPanelIndex()}
												onClusterInfoScrollBoxReady={(ref) => {
													appStore.kubernetesScrollBoxRefs[0] = ref;
												}}
												onPodsScrollBoxReady={(ref) => {
													appStore.kubernetesScrollBoxRefs[2] = ref;
												}}
												onWorkloadsScrollBoxReady={(ref) => {
													appStore.kubernetesScrollBoxRefs[3] = ref;
												}}
											/>
										</Show>
									}
								>
									<box
										style={{
											width: "100%",
											flexGrow: 1,
											minHeight: 0,
											flexDirection: "column",
											overflow: "hidden",
										}}
									>
										<ProgressAnimationDemo />
									</box>
								</Show>
							</box>,
						]}
					/>
				</Show>
			)}
			<Show when={appStore.loading()}>
				<StartupSplash appStore={appStore} />
			</Show>
			<Show
				when={
					appStore.isShuttingDown() || appStore.shutdownState().phase !== "idle"
				}
			>
				<ShutdownSplash appStore={appStore} />
			</Show>
		</>
	);
}
