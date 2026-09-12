# devenv / agentic-coding merge parity inventory

Status: baseline established by change `import-devenv-into-agentic-coding` (migration
change 1 of 11). Versioned against the imported devenv revision
`775579a8be625f7074c55a5971ab84ea30265fd4` and the merged-repository baseline
`6a393cab41f5e1d0d883f915cb46d2096597df39`.

This is the **no-feature-loss gate**: every later migration change that claims a
feature, subview, route, action, command or platform as migrated must update the
"Intended owner" and "Migration status" columns here and attach acceptance evidence.
Deleting a user-facing entrypoint is never evidence of preservation.

Owners during change 1 are unchanged: Go still owns every HTTP route and action, the
imported `@devenv/cli|core|types|ui` packages own the devenv TUI, and the
agentic-coding workflow engine/CLI/TUI remains exactly as it was.

## 1. Agentic-coding surfaces

The merged repository must preserve the existing agentic-coding application as well as
the imported one. These are the user-visible surfaces that later changes must keep
reachable and covered.

### 1.1 CLI surfaces

`agentic-coding/src/cli.ts` dispatches:

| Surface | Behavior | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| `agentic-coding workflow` | Transactional workflow engine CLI (see verbs below) | agentic-coding | unchanged (change 1) | `test/workflow-cli.test.ts`, `bun run test` | present, unmigrated |
| `agentic-coding dash` | Per-workflow dashboard TUI (`--repo --workflow-id`, `--profile test`, `--json`) | agentic-coding | unchanged | `test/workflow-dashboard.test.ts`, `test/dash/*` | present, unmigrated |
| `agentic-coding home` | Workflow list + observability TUI (long-lived) | agentic-coding | unchanged | `test/otel/*`, `test/workflow-observability.test.ts` | present, unmigrated |
| `agentic-coding manager` | Alias for `home` (Herdr manager launch) | agentic-coding | unchanged | `test/herdr-client.test.ts` | present, unmigrated |
| `__dashboard-observe` | Internal JSON observation bridge for the dashboard | agentic-coding | unchanged | `test/workflow-dashboard.test.ts` | present, unmigrated |

### 1.2 Workflow CLI verbs

| Verb | Purpose | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| `start` | Start a pinned workflow definition | agentic-coding | unchanged | `test/workflow-startup.test.ts`, `test/workflow-registry.test.ts` | present, unmigrated |
| `status` | Print observational workflow view | agentic-coding | unchanged | `test/workflow-runtime.test.ts` | present, unmigrated |
| `drain` | Explicitly execute due workflow effects | agentic-coding | unchanged | `test/workflow-effects.test.ts` | present, unmigrated |
| `action` | Dispatch revision-bound engine action | agentic-coding | unchanged | `test/workflow-execution.test.ts` | present, unmigrated |
| `handoff` | Submit run-bound agent outcome | agentic-coding | unchanged | `test/workflow-agent-consult.test.ts` | present, unmigrated |
| `question` | Ask the developer a bounded question | agentic-coding | unchanged | `test/workflow-question.test.ts` | present, unmigrated |
| `ask` | Ask a completed peer agent a bounded question | agentic-coding | unchanged | `test/workflow-agent-consult.test.ts` | present, unmigrated |
| `answer` | Answer a peer agent question | agentic-coding | unchanged | `test/workflow-question.test.ts` | present, unmigrated |
| `research-handoff` | Record structured handoff and start wiki drafting | agentic-coding | unchanged | `test/workflow-plan-*`, `test/pi/*` | present, unmigrated |
| `repair` | Repair to a compatible step | agentic-coding | unchanged | `test/workflow-migration.test.ts` | present, unmigrated |
| `repin` | Re-pin to the current definition digest | agentic-coding | unchanged | `test/workflow-migration.test.ts` | present, unmigrated |
| `migrate` | Preview/apply a revision-bound semantic migration | agentic-coding | unchanged | `test/workflow-migration.test.ts` | present, unmigrated |
| `projects` | List configured projects | agentic-coding | change 4 replaces discovery | `test/workflow-config-root-cache.test.ts` | present, migration pending |
| `config` | Print resolved configuration | agentic-coding | unchanged | `test/workflow-config-root-cache.test.ts` | present, unmigrated |
| `agent-extension` | Manage Pi agent extensions | agentic-coding | unchanged | `test/workflow-assets.test.ts` | present, unmigrated |
| `wiki` | Read/update the OKF wiki (list/search/show/write/verify/log) | agentic-coding | unchanged | `test/workflow-e2e.test.ts` | present, unmigrated |
| `sidebar` | Clear owned Herdr sidebar metadata/custom view | agentic-coding | unchanged | `test/workflow-sidebar*.test.ts` | present, unmigrated |

### 1.3 TUI surfaces

| Surface | Views/panels | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Dashboard (`dash`) | Overview, detail, artifacts, wiki changes/diff, local changes/diff, review, telemetry, project/workflow pickers | agentic-coding | change 3 integrates into one shell | `test/workflow-dashboard.test.ts`, `test/dash/*` | present, unmigrated |
| Observability shell (`otel`) | Selection, Detail, Span views; Logs, Metrics, Topology, Wiki views; filter/sort/theme/help modals | agentic-coding | change 3 integrates into one shell | `test/otel/*`, `test/tui-tracing.test.ts` | present, unmigrated |
| Workflow lifecycle modals | Start/confirm/create, agent presets/profiles, execution environment, review | agentic-coding | unchanged | `test/lifecycleModal.test.tsx`, `test/lifecycle.test.ts` | present, unmigrated |
| Herdr sidebar provider | Owned sidebar metadata and custom view | agentic-coding | unchanged | `test/herdr-client.test.ts`, `test/workflow-sidebar*.test.ts` | present, unmigrated |
| Workflow engine + outbox + session telemetry | Graph/step execution, durable retries, telemetry bridge | agentic-coding | unchanged (constraint: no engine rewrite during merge) | `test/workflow-*.test.ts`, `test/opencode-*.test.ts` | present, unmigrated |

## 2. devenv TUI shell surfaces

Top-level tabs (`TabType`: applications, infrastructure, libraries, scripts,
kubernetes, ui-test) and view modes (`ViewMode`) are the imported feature map. Every
mode routes to an imported view component; none is dropped by the import.

| Feature | Owning surface | Component(s) | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Applications / Libraries / Infrastructure tables | `table` view | `Table`, `AppDetailView`, `ContentStack` | devenv `ui`+`cli` | unchanged (change 1) | keymap/table tests | imported |
| Tasks (scripts) | `table` view (tab scripts) | `TaskTable`, `TaskArgsModal`, `TaskAddModal` | devenv `ui`+`cli` | unchanged | imported tests | imported |
| Kubernetes cluster | `table` view (tab kubernetes) | `KubernetesClusterView`, `ResourceTimelineCharts`, `DependencyTreeView` | devenv `ui`+`cli` | unchanged | `KubernetesClusterView.test.ts` | imported |
| UI test tab | `table` view (tab ui-test) | `ProgressAnimationDemo`, animation components | devenv `ui` | unchanged | imported tests | imported |
| App/infra detail | `appDetail` | `AppDetailView`, `DetailSection`, `PropertiesList` | devenv `ui`+`cli` | unchanged | imported tests | imported |
| Action runs | `actions` | `actions-view`, `ActionRunModal`, `ContentStack` | devenv `cli` | unchanged | `actions-keys.test.ts`, `action-run-store.test.ts` | imported |
| Providers | `providers` | `ProvidersView`, `ConnectProviderModal`, `AddRepositoryModal` | devenv `ui` | unchanged | imported tests | imported |
| Change request list/detail | `changeRequests`, `changeRequestDetail` | `ChangeRequestView`, `ChangeRequestDetailView`, `DiffViewModal`, `CommentModal` | devenv `ui` | unchanged | imported tests | imported |
| Changed files | `changedFiles` | `ChangedFilesView` | devenv `ui` | unchanged | imported tests | imported |
| Discussions | `discussionsView` | `DiscussionsView`, `CommentModal` | devenv `ui` | unchanged | imported tests | imported |
| CI test results / jobs | `testResults`, `jobs` | `TestResultsDetailView`, `TestDetailModal`, `JobsDetailView` | devenv `ui` | unchanged | imported tests | imported |
| Issues | `issues`, `issueDetail`, `issueTimeline`, `changeRequestLinkedIssues` | `IssueView`, `IssueScopeModal`, `IssueDetailView`, `TimelineView` | devenv `ui` | unchanged | imported tests | imported |
| References | `references` | `ReferencesView` | devenv `ui` | unchanged | imported tests | imported |
| Agent view | `agentView` | `AgentSpaceView`, `agent-actions` | devenv `ui`+`cli` | unchanged | imported tests | imported |
| SSH host picker | `sshPicker` | `SshHostPickerView`, `PassphraseModal` | devenv `ui` | unchanged | imported tests | imported |
| Help / keybind modal | `help` | `HelpView`, `HelpText`, `keymap-metadata` | devenv `ui`+`cli` | unchanged | `keymap-metadata.test.ts`, `keymap-conflicts.test.ts` | imported |
| Modals (theme, editor, branch, filter, sort, labels, assignee, confirm, passphrase, worktree, log/AI, CR AI review) | modal stack | `*Modal`, `*Picker*`, `*Overlay` components | devenv `ui`+`cli` | unchanged | modal/keymap tests | imported |

## 3. HTTP API routes

The Go backend registers 101 routes across the domains below. All are imported
unchanged and remain Go-owned during change 1. `Method` `ANY` means the route is
registered without a method filter.

### actions

| Method | Path | Handler | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Get | `/api/action-definition` | `s.handleGetActionDefinition` | Go `server/pkg/server` | Go (change 1) | `server/pkg/action{def,registry,exec,run}/*_test.go` | imported, unmigrated |
| Get | `/api/action-registry/status` | `s.handleActionRegistryStatus` | Go `server/pkg/server` | Go (change 1) | `server/pkg/action{def,registry,exec,run}/*_test.go` | imported, unmigrated |
| Post | `/api/action-runs` | `s.handleStartActionRun` | Go `server/pkg/server` | Go (change 1) | `server/pkg/action{def,registry,exec,run}/*_test.go` | imported, unmigrated |
| Post | `/api/actions/cancel` | `s.handleCancelAction` | Go `server/pkg/server` | Go (change 1) | `server/pkg/action{def,registry,exec,run}/*_test.go` | imported, unmigrated |
| Post | `/api/actions/events` | `s.handleReportedActionEvent` | Go `server/pkg/server` | Go (change 1) | `server/pkg/action{def,registry,exec,run}/*_test.go` | imported, unmigrated |
| Get | `/api/actions/history` | `s.handleActionHistory` | Go `server/pkg/server` | Go (change 1) | `server/pkg/action{def,registry,exec,run}/*_test.go` | imported, unmigrated |
| Get | `/api/actions/logs` | `s.handleActionLogs` | Go `server/pkg/server` | Go (change 1) | `server/pkg/action{def,registry,exec,run}/*_test.go` | imported, unmigrated |
| Get | `/api/actions/shell-script` | `s.handleShellActionScript` | Go `server/pkg/server` | Go (change 1) | `server/pkg/action{def,registry,exec,run}/*_test.go` | imported, unmigrated |
| Get | `/api/apps/{ident}/actions` | `s.handleListActionDefinitions` | Go `server/pkg/server` | Go (change 1) | `server/pkg/action{def,registry,exec,run}/*_test.go` | imported, unmigrated |

### ai

| Method | Path | Handler | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Post | `/api/ai/analyze-logs` | `s.handleAIAnalyzeLogs` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server` AI handlers (no dedicated Go test) | imported, unmigrated |
| Get | `/api/ai/analyze-logs-stream` | `s.handleAIAnalyzeLogsStream` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server` AI handlers (no dedicated Go test) | imported, unmigrated |
| Post | `/api/ai/cr-comment-callback/` | `s.handleCRCommentCallback` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server` AI handlers (no dedicated Go test) | imported, unmigrated |
| Get | `/api/ai/cr-review-stream` | `s.handleAICRReviewStream` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server` AI handlers (no dedicated Go test) | imported, unmigrated |

### app

| Method | Path | Handler | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Get | `/api/apps` | `s.handleGetApps` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go`; `server/pkg/app/*_test.go` | imported, unmigrated |
| Post | `/api/apps/create` | `s.handleCreateApp` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go`; `server/pkg/app/*_test.go` | imported, unmigrated |
| Delete | `/api/apps/{ident}/delete` | `s.handleDeleteApp` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go`; `server/pkg/app/*_test.go` | imported, unmigrated |
| Get | `/api/apps/{ident}/docker` | `s.handleGetDockerInfo` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go`; `server/pkg/app/*_test.go` | imported, unmigrated |
| Get | `/api/apps/{ident}/git` | `s.handleGetGitInfo` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go`; `server/pkg/app/*_test.go` | imported, unmigrated |
| Get | `/api/apps/{ident}/profiles` | `s.handleGetProfiles` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go`; `server/pkg/app/*_test.go` | imported, unmigrated |
| Post | `/api/example-config` | `s.handleCreateExampleConfig` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go`; `server/pkg/app/*_test.go` | imported, unmigrated |
| Get | `/api/infra-services` | `s.handleGetInfraServices` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go`; `server/pkg/app/*_test.go` | imported, unmigrated |
| Get | `/api/infra-services/{ident}/logs` | `s.handleInfraServiceLogs` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go`; `server/pkg/app/*_test.go` | imported, unmigrated |
| Get | `/api/status` | `s.handleGetStatus` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go`; `server/pkg/app/*_test.go` | imported, unmigrated |

### docker

| Method | Path | Handler | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Get | `/api/docker/logs` | `s.handleDockerLogs` | Go `server/pkg/server` | Go (change 1) | `server/pkg/docker/*_test.go` | imported, unmigrated |
| Get | `/api/docker/logs/stream` | `s.handleDockerLogsStream` | Go `server/pkg/server` | Go (change 1) | `server/pkg/docker/*_test.go` | imported, unmigrated |
| Post | `/api/docker/restart` | `s.handleDockerRestart` | Go `server/pkg/server` | Go (change 1) | `server/pkg/docker/*_test.go` | imported, unmigrated |
| Post | `/api/docker/start` | `s.handleDockerStart` | Go `server/pkg/server` | Go (change 1) | `server/pkg/docker/*_test.go` | imported, unmigrated |
| Get | `/api/docker/stats/stream` | `s.handleDockerStatsStream` | Go `server/pkg/server` | Go (change 1) | `server/pkg/docker/*_test.go` | imported, unmigrated |
| Post | `/api/docker/stop` | `s.handleDockerStop` | Go `server/pkg/server` | Go (change 1) | `server/pkg/docker/*_test.go` | imported, unmigrated |

### git

| Method | Path | Handler | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Get | `/api/git/branches` | `s.handleGitBranches` | Go `server/pkg/server` | Go (change 1) | `server/pkg/git/*_test.go` | imported, unmigrated |
| Get | `/api/git/worktrees` | `s.handleWorktrees` | Go `server/pkg/server` | Go (change 1) | `server/pkg/git/*_test.go` | imported, unmigrated |

### github

| Method | Path | Handler | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Get | `/api/github/actions-job-logs` | `s.handleGitHubActionsJobLogs` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/actions-jobs` | `s.handleGitHubActionsJobs` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/actions-test-summary` | `s.handleGitHubActionsTestSummary` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/collaborators` | `s.handleGitHubRepoCollaborators` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/cr/linked-issues` | `s.handleGitHubCRLinkedIssues` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/issue` | `s.handleGitHubIssueDetail` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/issue-comments` | `s.handleGitHubIssueComments` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/issues` | `s.handleGitHubIssues` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Post | `/api/github/issues/assignee` | `s.handleGitHubSetAssignee` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Post | `/api/github/issues/close` | `s.handleGitHubCloseIssue` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Post | `/api/github/issues/comment` | `s.handleGitHubAddComment` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Post | `/api/github/issues/labels` | `s.handleGitHubSetLabels` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/issues/linked-crs` | `s.handleGitHubIssueLinkedCRs` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/issues/references` | `s.handleGitHubIssueReferencedIssues` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Post | `/api/github/issues/reopen` | `s.handleGitHubReopenIssue` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Post | `/api/github/issues/unassign` | `s.handleGitHubRemoveAssignee` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/labels` | `s.handleGitHubRepoLabels` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Post | `/api/github/pr-approve` | `s.handleGitHubPRApprove` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/pr-changes` | `s.handleGitHubPRChanges` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/pr-discussions` | `s.handleGitHubPRDiscussions` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Post | `/api/github/pr-toggle-approval` | `s.handleGitHubPRToggleApproval` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Post | `/api/github/pr-unapprove` | `s.handleGitHubPRUnapprove` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/pull-request` | `s.handleGitHubPullRequest` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |
| Get | `/api/github/pull-requests` | `s.handleGitHubPullRequests` | Go `server/pkg/server` | Go (change 1) | `server/pkg/github/*_test.go` | imported, unmigrated |

### gitlab

| Method | Path | Handler | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Get | `/api/gitlab/collaborators` | `s.handleGitLabRepoCollaborators` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/cr-approve` | `s.handleGitLabMRApprove` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/cr-changes` | `s.handleGitLabChangeRequestChanges` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/cr-comment` | `s.handleGitLabMRComment` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/cr-discussion-reply` | `s.handleGitLabMRDiscussionReply` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/cr-discussion-resolve` | `s.handleGitLabMRDiscussionResolve` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/cr-discussions` | `s.handleGitLabMRDiscussions` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/cr-rebase` | `s.handleGitLabMRRebase` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/cr-toggle-approval` | `s.handleGitLabMRToggleApproval` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/cr-unapprove` | `s.handleGitLabMRUnapprove` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/cr-versions` | `s.handleGitLabMRVersions` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/cr/linked-issues` | `s.handleGitLabCRLinkedIssues` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/issue` | `s.handleGitLabIssueDetail` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/issue-comments` | `s.handleGitLabIssueComments` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/issues` | `s.handleGitLabIssues` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/issues/assignee` | `s.handleGitLabSetAssignee` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/issues/close` | `s.handleGitLabCloseIssue` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/issues/comment` | `s.handleGitLabAddComment` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/issues/labels` | `s.handleGitLabSetLabels` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/issues/linked-crs` | `s.handleGitLabIssueLinkedCRs` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/issues/references` | `s.handleGitLabIssueReferencedIssues` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/issues/reopen` | `s.handleGitLabReopenIssue` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/issues/unassign` | `s.handleGitLabRemoveAssignee` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/job-cancel` | `s.handleGitLabJobCancel` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/job-logs` | `s.handleGitLabJobLogs` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Post | `/api/gitlab/job-retry` | `s.handleGitLabJobRetry` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/jobs` | `s.handleGitLabJobs` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/labels` | `s.handleGitLabRepoLabels` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/merge-requests` | `s.handleGitLabChangeRequests` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |
| Get | `/api/gitlab/test-summary` | `s.handleGitLabTestSummary` | Go `server/pkg/server` | Go (change 1) | `server/pkg/gitlab/*_test.go` | imported, unmigrated |

### kubernetes

| Method | Path | Handler | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Get | `/api/kubernetes/cluster` | `s.handleKubernetesClusterStatus` | Go `server/pkg/server` | Go (change 1) | `server/pkg/kubernetes/*_test.go`, `server/pkg/build/kubernetes_*_test.go` | imported, unmigrated |
| Post | `/api/kubernetes/cluster/refresh` | `s.handleKubernetesClusterRefresh` | Go `server/pkg/server` | Go (change 1) | `server/pkg/kubernetes/*_test.go`, `server/pkg/build/kubernetes_*_test.go` | imported, unmigrated |
| Get | `/api/kubernetes/logs` | `s.handleKubernetesLogs` | Go `server/pkg/server` | Go (change 1) | `server/pkg/kubernetes/*_test.go`, `server/pkg/build/kubernetes_*_test.go` | imported, unmigrated |

### providers

| Method | Path | Handler | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| "" | `/api/providers` | `s.handleProviders` | Go `server/pkg/server` | Go (change 1) | `server/pkg/provider/*_test.go` | imported, unmigrated |
| "" | `/api/providers/` | `s.handleProviderByName` | Go `server/pkg/server` | Go (change 1) | `server/pkg/provider/*_test.go` | imported, unmigrated |

### repos

| Method | Path | Handler | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Get | `/api/repos/branches` | `s.handleRepoBranches` | Go `server/pkg/server` | Go (change 1) | `server/pkg/provider/*_test.go`, `server/pkg/git/*_test.go` | imported, unmigrated |
| Get | `/api/repos/search` | `s.handleRepoSearch` | Go `server/pkg/server` | Go (change 1) | `server/pkg/provider/*_test.go`, `server/pkg/git/*_test.go` | imported, unmigrated |

### scripts

| Method | Path | Handler | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Get | `/api/scripts` | `s.handleScripts` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/scripts_test.go`, `server/pkg/resources/*_test.go` | imported, unmigrated |
| Post | `/api/scripts/create` | `s.handleCreateScript` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/scripts_test.go`, `server/pkg/resources/*_test.go` | imported, unmigrated |
| Delete | `/api/scripts/delete` | `s.handleDeleteScript` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/scripts_test.go`, `server/pkg/resources/*_test.go` | imported, unmigrated |
| Get | `/api/scripts/history` | `s.handleScriptArgsHistory` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/scripts_test.go`, `server/pkg/resources/*_test.go` | imported, unmigrated |
| Post | `/api/scripts/link` | `s.handleLinkScript` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/scripts_test.go`, `server/pkg/resources/*_test.go` | imported, unmigrated |
| Get | `/api/scripts/metadata` | `s.handleScriptMetadataRoute` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/scripts_test.go`, `server/pkg/resources/*_test.go` | imported, unmigrated |

### system

| Method | Path | Handler | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Get | `/api/events` | `s.handleEvents` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go` | imported, unmigrated |
| Get | `/api/health` | `s.handleHealth` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go` | imported, unmigrated |
| Get | `/api/pi-sessions` | `s.handleGetPiSessions` | Go `server/pkg/server` | Go (change 1) | `server/pkg/server/routes_test.go` | imported, unmigrated |

## 4. Action runtimes and action keys

Runtimes (`ActionRuntime`): `docker`, `shell`, `powershell`, `systemshell`,
`kubernetes`. Launch modes: `logged`, `tmux`.

| Item | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- |
| Runtime `docker` | Go `pkg/docker`, `pkg/actionexec` | unchanged (change 1) | `server/pkg/docker/*_test.go`, `server/pkg/actionexec/*_test.go` | imported |
| Runtime `shell` / `systemshell` | Go `pkg/actionexec`, `pkg/operations` | unchanged | `server/pkg/actionexec/*_test.go`, `server/pkg/operations/*_test.go` | imported |
| Runtime `powershell` | Go `pkg/actionexec` | unchanged | `server/pkg/actionexec/*_test.go` | imported |
| Runtime `kubernetes` | Go `pkg/kubernetes`, `pkg/build` | unchanged | `server/pkg/kubernetes/*_test.go`, `server/pkg/build/kubernetes_*_test.go` | imported |
| Launch mode `logged` / `tmux` | devenv `cli` + Go `operations` | unchanged | `server/pkg/operations/*_test.go`, imported TUI tests | imported |

Machine action keys with first-class labels (`types/src/action-labels.ts`); unrecognised
keys fall back to title-casing, so no action family is lost:

| Machine key | Label | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| `run` / `start` | Start | Go action registry | unchanged (change 1) | `server/pkg/action{def,registry}/*_test.go` | imported |
| `build` | Build | Go action registry | unchanged | `server/pkg/action{def,registry}/*_test.go` | imported |
| `test` | Test | Go action registry | unchanged | `server/pkg/action{def,registry}/*_test.go` | imported |
| `stop` | Stop | Go action registry | unchanged | `server/pkg/action{def,registry}/*_test.go` | imported |
| `task.run` | Run task | Go action registry | unchanged | `server/pkg/action{def,registry}/*_test.go` | imported |
| `git.pull` / `git.push` / `git.fetch` / `git.checkout` | Git pull / push / fetch / checkout | Go `pkg/git`, `pkg/build` | unchanged | `server/pkg/git/*_test.go` | imported |
| `git.worktree.create` / `git.worktree.remove` | Create / remove worktree | Go `pkg/git` | unchanged | `server/pkg/git/*_test.go` | imported |
| `kubernetes.cluster.create` / `.delete` / `.recreate` / `.export` | Kubernetes cluster create/delete/recreate/export kubeconfig | Go `pkg/kubernetes`, `pkg/build` | unchanged | `server/pkg/kubernetes/*_test.go` | imported |
| `docker.container.start` / `.stop` / `.restart` | Start / stop / restart container | Go `pkg/docker` | unchanged | `server/pkg/docker/*_test.go` | imported |

The immutable action registry, semantic vs execution identity, one-command-per-leaf
and readiness semantics live in `server/pkg/actiondef`, `server/pkg/actionregistry`,
`server/pkg/actionexec` and `server/pkg/actionrun`.

## 5. CLI modes

| CLI | Mode | Behavior | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| devenv | `spawn` (default) | Start managed Go server on `--port` (default 4050) then OpenTUI frontend | devenv `cli` | unchanged (change 1) | source launch `bun run dev:devenv`, imported tests | imported |
| devenv | `attach <url>` | Attach TUI to a running server without owning it | devenv `cli` | unchanged | `spawn.ts` | imported |
| devenv | `server` | Start only the Go backend (embedded binary or `go run`) | devenv `cli` | unchanged | `server-lifecycle.ts` | imported |
| agentic-coding | `workflow` / `dash` / `home` / `manager` | See section 1.1 | agentic-coding | unchanged | `test/workflow-cli.test.ts`, `test/workflow-dashboard.test.ts` | present, unmigrated |

## 6. Configuration and data locations

| Location | Purpose | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| `$DEVENV_HOME` (default `~/devenv`) | Per-install state and `logs/server.log` | devenv `cli`+Go | unchanged (change 1) | `server/pkg/resources/*_test.go`, imported tests | imported, format unchanged |
| `$DEVENV_CONFIG_DIR` (default `~/.config/devenv`) | App/library/script definitions, build/run profiles, `tui.json` preferences | devenv `cli`+Go | unchanged | `server/pkg/exampleconfig/*_test.go` | imported, format unchanged |
| `~/.config/devenv/.env` | Env overrides, including `DEVENV_HOME` | devenv `cli` | unchanged | `server/pkg/resources/envfile_test.go` | imported, format unchanged |
| Go `state`/SQLite stores | Domain persistence | Go `pkg/state` | unchanged | `server/pkg/state/*_test.go` | imported, no schema change |
| agentic-coding workflow store + `.herdr-workflow/` | Workflow runtime state | agentic-coding | unchanged | `test/workflow-runtime.test.ts` | present, unmigrated |

No repository location, database or config format is moved or rewritten by this
change. Operator project reconciliation is a prerequisite for change 4, documented in
`devenv-project-reconciliation.md`.

## 7. Supported platforms

| Platform target | Old owner | Intended owner | Evidence | Status |
| --- | --- | --- | --- | --- |
| `linux-arm64`, `linux-x64`, `linux-x64` baseline | devenv build script + Go | unchanged (change 1) | `packages/devenv/scripts/build.ts` targets; not built here | build target only |
| `linux-arm64-musl`, `linux-x64-musl` (+ baseline) | devenv build script + Go | unchanged | `packages/devenv/scripts/build.ts` targets; not built here | build target only |
| `darwin-arm64` | devenv build script + Go | unchanged | `bun run build:devenv:single` (this host) | built + smoke-checked |
| `darwin-x64` (+ baseline) | devenv build script + Go | unchanged | `packages/devenv/scripts/build.ts` targets; not built here | build target only |
| `win32-x64` (+ baseline) | devenv build script + Go | unchanged | `*_windows.go` paths; not built here | build target only, containment unsupported |

Only the host target is built and checked during local iteration. Platform coverage
beyond the host is recorded as build targets, not tested support.

## 8. Verification evidence

| Check | Command | Result |
| --- | --- | --- |
| Combined verification | `bun run verify` | exit 0 (lint, type-check, both Bun suites, Go test/vet) |
| Lint (both apps) | `bun run lint` | 696 files, zero diagnostics |
| Type-check (both apps) | `bun run type-check` | clean |
| Imported TUI suite | `bun test packages/devenv` | 0 fail |
| agentic-coding suite | `bun run test` (inside `verify`) | 0 fail |
| Go tests | `cd server && go test ./...` | all packages `ok` |
| Go vet | `cd server && go vet ./...` | exit 0 |
| agentic-coding build | `bun run build` | executable + gRPC sidecar |
| devenv host build | `bun run build:devenv:single` | `devenv-darwin-arm64/bin/devenv` produced |

No real destructive environment action (container/kubernetes start-stop) was executed
while establishing the baseline.

## 9. Known gaps and out-of-scope

- Go remains the authoritative owner of all routes and actions; this change only
  imports it.
- `install.sh` still describes the pre-merge `dist/tui/<platform>/bin` release layout
  and is not wired to a script. `install-remote.sh` was removed during the import
  because it fetched an unsigned release from a third-party repository and stripped
  the macOS quarantine attribute (see the fix-round security dispositions).
- Provider/network integrations (GitHub, GitLab, AI) are validated by their Go tests
  rather than live provider calls.
- Redistribution remains gated on reconciling the retained MIT `LICENSE` text against
  the `PROPRIETARY` package metadata (see `devenv-import.md`).

## Maintenance rule

When a later change moves ownership, update this file in the same change: set the
"Intended owner" and "Migration status" cells, add the specific test or interactive
evidence, and keep the old owner until the new owner passes that evidence.
