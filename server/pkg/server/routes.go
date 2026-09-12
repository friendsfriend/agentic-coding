package server

import (
	"encoding/json"
	"net/http"
)

type routeSpec struct {
	Domain  string
	Method  string
	Path    string
	Handler func(http.ResponseWriter, *http.Request)
}

func (s *Server) routes() []routeSpec {
	return []routeSpec{
		{Domain: "app", Method: http.MethodGet, Path: "/api/apps", Handler: s.handleGetApps},
		{Domain: "app", Method: http.MethodGet, Path: "/api/infra-services", Handler: s.handleGetInfraServices},
		{Domain: "app", Method: http.MethodGet, Path: "/api/infra-services/{ident}/logs", Handler: s.handleInfraServiceLogs},
		{Domain: "app", Method: http.MethodGet, Path: "/api/status", Handler: s.handleGetStatus},
		{Domain: "app", Method: http.MethodGet, Path: "/api/apps/{ident}/docker", Handler: s.handleGetDockerInfo},
		{Domain: "app", Method: http.MethodGet, Path: "/api/apps/{ident}/git", Handler: s.handleGetGitInfo},
		{Domain: "app", Method: http.MethodPost, Path: "/api/apps/create", Handler: s.handleCreateApp},
		{Domain: "app", Method: http.MethodPost, Path: "/api/example-config", Handler: s.handleCreateExampleConfig},
		{Domain: "app", Method: http.MethodDelete, Path: "/api/apps/{ident}/delete", Handler: s.handleDeleteApp},
		{Domain: "app", Method: http.MethodGet, Path: "/api/apps/{ident}/profiles", Handler: s.handleGetProfiles},
		{Domain: "actions", Method: http.MethodGet, Path: "/api/apps/{ident}/actions", Handler: s.handleListActionDefinitions},
		{Domain: "actions", Method: http.MethodGet, Path: "/api/action-definition", Handler: s.handleGetActionDefinition},
		{Domain: "actions", Method: http.MethodGet, Path: "/api/action-registry/status", Handler: s.handleActionRegistryStatus},
		{Domain: "actions", Method: http.MethodPost, Path: "/api/action-runs", Handler: s.handleStartActionRun},

		{Domain: "docker", Method: http.MethodPost, Path: "/api/docker/start", Handler: s.handleDockerStart},
		{Domain: "docker", Method: http.MethodPost, Path: "/api/docker/stop", Handler: s.handleDockerStop},
		{Domain: "docker", Method: http.MethodPost, Path: "/api/docker/restart", Handler: s.handleDockerRestart},
		{Domain: "docker", Method: http.MethodGet, Path: "/api/docker/logs", Handler: s.handleDockerLogs},
		{Domain: "docker", Method: http.MethodGet, Path: "/api/docker/logs/stream", Handler: s.handleDockerLogsStream},
		{Domain: "docker", Method: http.MethodGet, Path: "/api/docker/stats/stream", Handler: s.handleDockerStatsStream},

		{Domain: "kubernetes", Method: http.MethodGet, Path: "/api/kubernetes/logs", Handler: s.handleKubernetesLogs},
		{Domain: "kubernetes", Method: http.MethodGet, Path: "/api/kubernetes/cluster", Handler: s.handleKubernetesClusterStatus},
		{Domain: "kubernetes", Method: http.MethodPost, Path: "/api/kubernetes/cluster/refresh", Handler: s.handleKubernetesClusterRefresh},

		{Domain: "git", Method: http.MethodGet, Path: "/api/git/branches", Handler: s.handleGitBranches},
		{Domain: "git", Method: http.MethodGet, Path: "/api/git/worktrees", Handler: s.handleWorktrees},

		{Domain: "actions", Method: http.MethodPost, Path: "/api/actions/cancel", Handler: s.handleCancelAction},
		{Domain: "actions", Method: http.MethodGet, Path: "/api/actions/history", Handler: s.handleActionHistory},
		{Domain: "actions", Method: http.MethodGet, Path: "/api/actions/logs", Handler: s.handleActionLogs},
		{Domain: "actions", Method: http.MethodPost, Path: "/api/actions/events", Handler: s.handleReportedActionEvent},
		{Domain: "actions", Method: http.MethodGet, Path: "/api/actions/shell-script", Handler: s.handleShellActionScript},

		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/merge-requests", Handler: s.handleGitLabChangeRequests},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/jobs", Handler: s.handleGitLabJobs},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/test-summary", Handler: s.handleGitLabTestSummary},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/cr-changes", Handler: s.handleGitLabChangeRequestChanges},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/cr-versions", Handler: s.handleGitLabMRVersions},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/cr-comment", Handler: s.handleGitLabMRComment},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/cr-discussions", Handler: s.handleGitLabMRDiscussions},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/cr-discussion-reply", Handler: s.handleGitLabMRDiscussionReply},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/cr-discussion-resolve", Handler: s.handleGitLabMRDiscussionResolve},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/cr-approve", Handler: s.handleGitLabMRApprove},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/cr-unapprove", Handler: s.handleGitLabMRUnapprove},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/cr-toggle-approval", Handler: s.handleGitLabMRToggleApproval},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/cr-rebase", Handler: s.handleGitLabMRRebase},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/job-logs", Handler: s.handleGitLabJobLogs},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/job-retry", Handler: s.handleGitLabJobRetry},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/job-cancel", Handler: s.handleGitLabJobCancel},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/issues", Handler: s.handleGitLabIssues},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/issue", Handler: s.handleGitLabIssueDetail},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/issue-comments", Handler: s.handleGitLabIssueComments},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/issues/close", Handler: s.handleGitLabCloseIssue},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/issues/reopen", Handler: s.handleGitLabReopenIssue},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/issues/labels", Handler: s.handleGitLabSetLabels},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/issues/assignee", Handler: s.handleGitLabSetAssignee},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/issues/unassign", Handler: s.handleGitLabRemoveAssignee},
		{Domain: "gitlab", Method: http.MethodPost, Path: "/api/gitlab/issues/comment", Handler: s.handleGitLabAddComment},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/issues/linked-crs", Handler: s.handleGitLabIssueLinkedCRs},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/issues/references", Handler: s.handleGitLabIssueReferencedIssues},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/cr/linked-issues", Handler: s.handleGitLabCRLinkedIssues},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/labels", Handler: s.handleGitLabRepoLabels},
		{Domain: "gitlab", Method: http.MethodGet, Path: "/api/gitlab/collaborators", Handler: s.handleGitLabRepoCollaborators},

		{Domain: "github", Method: http.MethodGet, Path: "/api/github/pull-requests", Handler: s.handleGitHubPullRequests},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/pull-request", Handler: s.handleGitHubPullRequest},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/pr-changes", Handler: s.handleGitHubPRChanges},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/pr-discussions", Handler: s.handleGitHubPRDiscussions},
		{Domain: "github", Method: http.MethodPost, Path: "/api/github/pr-approve", Handler: s.handleGitHubPRApprove},
		{Domain: "github", Method: http.MethodPost, Path: "/api/github/pr-unapprove", Handler: s.handleGitHubPRUnapprove},
		{Domain: "github", Method: http.MethodPost, Path: "/api/github/pr-toggle-approval", Handler: s.handleGitHubPRToggleApproval},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/actions-jobs", Handler: s.handleGitHubActionsJobs},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/actions-test-summary", Handler: s.handleGitHubActionsTestSummary},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/actions-job-logs", Handler: s.handleGitHubActionsJobLogs},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/issues", Handler: s.handleGitHubIssues},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/issue", Handler: s.handleGitHubIssueDetail},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/issue-comments", Handler: s.handleGitHubIssueComments},
		{Domain: "github", Method: http.MethodPost, Path: "/api/github/issues/close", Handler: s.handleGitHubCloseIssue},
		{Domain: "github", Method: http.MethodPost, Path: "/api/github/issues/reopen", Handler: s.handleGitHubReopenIssue},
		{Domain: "github", Method: http.MethodPost, Path: "/api/github/issues/labels", Handler: s.handleGitHubSetLabels},
		{Domain: "github", Method: http.MethodPost, Path: "/api/github/issues/assignee", Handler: s.handleGitHubSetAssignee},
		{Domain: "github", Method: http.MethodPost, Path: "/api/github/issues/unassign", Handler: s.handleGitHubRemoveAssignee},
		{Domain: "github", Method: http.MethodPost, Path: "/api/github/issues/comment", Handler: s.handleGitHubAddComment},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/issues/linked-crs", Handler: s.handleGitHubIssueLinkedCRs},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/issues/references", Handler: s.handleGitHubIssueReferencedIssues},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/cr/linked-issues", Handler: s.handleGitHubCRLinkedIssues},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/labels", Handler: s.handleGitHubRepoLabels},
		{Domain: "github", Method: http.MethodGet, Path: "/api/github/collaborators", Handler: s.handleGitHubRepoCollaborators},

		{Domain: "ai", Method: http.MethodPost, Path: "/api/ai/analyze-logs", Handler: s.handleAIAnalyzeLogs},
		{Domain: "ai", Method: http.MethodGet, Path: "/api/ai/analyze-logs-stream", Handler: s.handleAIAnalyzeLogsStream},
		{Domain: "ai", Method: http.MethodGet, Path: "/api/ai/cr-review-stream", Handler: s.handleAICRReviewStream},
		{Domain: "ai", Method: http.MethodPost, Path: "/api/ai/cr-comment-callback/", Handler: s.handleCRCommentCallback},

		{Domain: "providers", Method: "", Path: "/api/providers", Handler: s.handleProviders},
		{Domain: "providers", Method: "", Path: "/api/providers/", Handler: s.handleProviderByName},
		{Domain: "repos", Method: http.MethodGet, Path: "/api/repos/search", Handler: s.handleRepoSearch},
		{Domain: "repos", Method: http.MethodGet, Path: "/api/repos/branches", Handler: s.handleRepoBranches},

		{Domain: "scripts", Method: http.MethodGet, Path: "/api/scripts", Handler: s.handleScripts},
		{Domain: "scripts", Method: http.MethodPost, Path: "/api/scripts/create", Handler: s.handleCreateScript},
		{Domain: "scripts", Method: http.MethodPost, Path: "/api/scripts/link", Handler: s.handleLinkScript},
		{Domain: "scripts", Method: http.MethodDelete, Path: "/api/scripts/delete", Handler: s.handleDeleteScript},
		{Domain: "scripts", Method: http.MethodGet, Path: "/api/scripts/history", Handler: s.handleScriptArgsHistory},
		{Domain: "scripts", Method: http.MethodGet, Path: "/api/scripts/metadata", Handler: s.handleScriptMetadataRoute},

		{Domain: "system", Method: http.MethodGet, Path: "/api/pi-sessions", Handler: s.handleGetPiSessions},
		{Domain: "system", Method: http.MethodGet, Path: "/api/events", Handler: s.handleEvents},
		{Domain: "system", Method: http.MethodGet, Path: "/api/health", Handler: s.handleHealth},
	}
}

func (s *Server) registerRoutes(mux *http.ServeMux) {
	for _, route := range s.routes() {
		mux.HandleFunc(route.Path, route.Handler)
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "homeDir": s.services.HomeDir()})
}
