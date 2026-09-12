package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/github"
	"github.com/friendsfriend/devenv/pkg/gitlab"
	"github.com/friendsfriend/devenv/pkg/issues"
)

// resolveGitHubIssueClient returns a GitHub issues client.
func (s *Server) resolveGitHubIssueClient(targetApp *app.App) (issues.Client, *github.RepoInfo, error) {
	return s.resolveGitHubIssueClientWithContext(context.Background(), targetApp)
}

func (s *Server) resolveGitHubIssueClientWithContext(ctx context.Context, targetApp *app.App) (issues.Client, *github.RepoInfo, error) {
	repoInfo, err := github.ExtractRepoInfo(targetApp.RepositoryPath)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to extract repo info: %w", err)
	}
	providerName := targetApp.GetProviderName()
	username, token := "", ""
	if s.services.ProviderStore() != nil {
		username, token = s.services.ProviderStore().CredentialsFor(providerName)
	}
	if token == "" {
		return nil, nil, fmt.Errorf("no token configured for provider %q", providerName)
	}
	ghClient := github.NewClientWithContext(ctx, token, username)
	issuesClient := github.NewIssuesClient(ghClient, repoInfo)
	return issuesClient, repoInfo, nil
}

// resolveGitLabIssueClient returns a GitLab issues client.
func (s *Server) resolveGitLabIssueClient(targetApp *app.App) (issues.Client, *gitlab.ProjectInfo, error) {
	return s.resolveGitLabIssueClientWithContext(context.Background(), targetApp)
}

func (s *Server) resolveGitLabIssueClientWithContext(ctx context.Context, targetApp *app.App) (issues.Client, *gitlab.ProjectInfo, error) {
	projectInfo, err := gitlab.ExtractProjectInfo(targetApp.RepositoryPath)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to extract project info: %w", err)
	}
	providerName := targetApp.GetProviderName()
	username, token := "", ""
	if s.services.ProviderStore() != nil {
		username, token = s.services.ProviderStore().CredentialsFor(providerName)
	}
	if token == "" {
		return nil, nil, fmt.Errorf("no token configured for provider %q", providerName)
	}
	baseURL := fmt.Sprintf("https://%s", projectInfo.Host)
	glClient := gitlab.NewClientWithContext(ctx, baseURL, token, username)
	issuesClient := gitlab.NewIssuesClient(glClient, projectInfo)
	return issuesClient, projectInfo, nil
}

func splitCSV(value string) []string {
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// handleGitHubIssues — GET /api/github/issues
func (s *Server) handleGitHubIssues(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	scope := r.URL.Query().Get("scope")
	search := r.URL.Query().Get("search")
	state := r.URL.Query().Get("state")
	sortBy := r.URL.Query().Get("sort")
	sortDirection := r.URL.Query().Get("direction")
	labels := splitCSV(r.URL.Query().Get("labels"))
	pageStr := r.URL.Query().Get("page")
	perPageStr := r.URL.Query().Get("perPage")

	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}
	if targetApp.RepositoryPath == "" {
		respondBadRequest(w, "App has no repository path")
		return
	}

	page := parsePage(pageStr)
	perPage := parsePerPage(perPageStr)

	if state == "" {
		state = "open"
	}

	issuesClient, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	debugLog("handleGitHubIssues: appIdent=%q scope=%q state=%q search=%q page=%d perPage=%d", appIdent, scope, state, search, page, perPage)

	result, err := issuesClient.GetIssues(nil, &issues.IssueListOptions{
		Scope:         scope,
		Search:        search,
		Labels:        labels,
		SortBy:        sortBy,
		SortDirection: sortDirection,
		Page:          page,
		PerPage:       perPage,
		State:         state,
	})
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch issues: %v", err), http.StatusInternalServerError)
		return
	}

	debugLog("handleGitHubIssues: returned %d items, scope=%q", len(result.Issues), scope)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// handleGitHubIssueDetail — GET /api/github/issues/{n}
func (s *Server) handleGitHubIssueDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	issue, err := issuesClient.GetIssue(nil, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch issue: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issue)
}

// handleGitHubIssueComments — GET /api/github/issues/{n}/comments
func (s *Server) handleGitHubIssueComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	comments, err := issuesClient.GetIssueComments(nil, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch issue comments: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(comments)
}

// handleGitLabIssues — GET /api/gitlab/issues
func (s *Server) handleGitLabIssues(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	scope := r.URL.Query().Get("scope")
	search := r.URL.Query().Get("search")
	state := r.URL.Query().Get("state")
	sortBy := r.URL.Query().Get("sort")
	sortDirection := r.URL.Query().Get("direction")
	labels := splitCSV(r.URL.Query().Get("labels"))
	pageStr := r.URL.Query().Get("page")
	perPageStr := r.URL.Query().Get("perPage")

	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}
	if targetApp.RepositoryPath == "" {
		respondBadRequest(w, "App has no repository path")
		return
	}

	page := parsePage(pageStr)
	perPage := parsePerPage(perPageStr)

	if state == "" {
		state = "opened"
	}

	issuesClient, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	result, err := issuesClient.GetIssues(nil, &issues.IssueListOptions{
		Scope:         scope,
		Search:        search,
		Labels:        labels,
		SortBy:        sortBy,
		SortDirection: sortDirection,
		Page:          page,
		PerPage:       perPage,
		State:         state,
	})
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch issues: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// handleGitLabIssueDetail — GET /api/gitlab/issues/{n}
func (s *Server) handleGitLabIssueDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	issue, err := issuesClient.GetIssue(nil, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch issue: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issue)
}

// handleGitLabIssueComments — GET /api/gitlab/issues/{n}/comments
func (s *Server) handleGitLabIssueComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	comments, err := issuesClient.GetIssueComments(nil, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch issue comments: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(comments)
}

// ─── GitHub Mutation Handlers ────────────────────────────────────────────────

// handleGitHubCloseIssue — POST /api/github/issues/{n}/close
func (s *Server) handleGitHubCloseIssue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	var closeReq struct {
		Reason string `json:"reason"`
	}
	// Reason is optional — ignore decode errors
	_ = json.NewDecoder(r.Body).Decode(&closeReq)

	issue, err := issuesClient.CloseIssue(nil, number, closeReq.Reason)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to close issue: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issue)
}

// handleGitHubReopenIssue — POST /api/github/issues/{n}/reopen
func (s *Server) handleGitHubReopenIssue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	issue, err := issuesClient.ReopenIssue(nil, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to reopen issue: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issue)
}

// handleGitHubSetLabels — POST /api/github/issues/{n}/labels
func (s *Server) handleGitHubSetLabels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	var payload struct {
		Labels []string `json:"labels"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		respondBadRequest(w, "Invalid request body")
		return
	}

	issuesClient, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	issue, err := issuesClient.SetLabels(nil, number, payload.Labels)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to set labels: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issue)
}

// handleGitHubSetAssignee — POST /api/github/issues/{n}/assignee
func (s *Server) handleGitHubSetAssignee(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	var payload struct {
		Assignee string `json:"assignee"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		respondBadRequest(w, "Invalid request body")
		return
	}

	issuesClient, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	issue, err := issuesClient.AddAssignee(nil, number, payload.Assignee)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to set assignee: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issue)
}

// handleGitHubRemoveAssignee — POST /api/github/issues/{n}/unassign
func (s *Server) handleGitHubRemoveAssignee(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	issue, err := issuesClient.RemoveAssignee(nil, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to remove assignee: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issue)
}

// handleGitHubRepoLabels — GET /api/github/labels
func (s *Server) handleGitHubRepoLabels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	labels, err := issuesClient.GetRepoLabels(nil)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch labels: %v", err), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string][]string{"labels": labels})
}

// handleGitHubRepoCollaborators — GET /api/github/collaborators
func (s *Server) handleGitHubRepoCollaborators(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	collaborators, err := issuesClient.GetRepoCollaborators(nil)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch collaborators: %v", err), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string][]string{"collaborators": collaborators})
}

// ─── GitLab Mutation Handlers ────────────────────────────────────────────────

// handleGitLabCloseIssue — POST /api/gitlab/issues/{n}/close
func (s *Server) handleGitLabCloseIssue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	var closeReq struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&closeReq)

	issue, err := issuesClient.CloseIssue(nil, number, closeReq.Reason)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to close issue: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issue)
}

// handleGitLabReopenIssue — POST /api/gitlab/issues/{n}/reopen
func (s *Server) handleGitLabReopenIssue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	issue, err := issuesClient.ReopenIssue(nil, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to reopen issue: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issue)
}

// handleGitLabSetLabels — POST /api/gitlab/issues/{n}/labels
func (s *Server) handleGitLabSetLabels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	var payload struct {
		Labels []string `json:"labels"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		respondBadRequest(w, "Invalid request body")
		return
	}

	issuesClient, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	issue, err := issuesClient.SetLabels(nil, number, payload.Labels)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to set labels: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issue)
}

// handleGitLabSetAssignee — POST /api/gitlab/issues/{n}/assignee
func (s *Server) handleGitLabSetAssignee(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	var payload struct {
		Assignee string `json:"assignee"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		respondBadRequest(w, "Invalid request body")
		return
	}

	issuesClient, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	issue, err := issuesClient.AddAssignee(nil, number, payload.Assignee)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to set assignee: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issue)
}

// handleGitLabRemoveAssignee — POST /api/gitlab/issues/{n}/unassign
func (s *Server) handleGitLabRemoveAssignee(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	issue, err := issuesClient.RemoveAssignee(nil, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to remove assignee: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issue)
}

// handleGitLabRepoLabels — GET /api/gitlab/labels
func (s *Server) handleGitLabRepoLabels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	labels, err := issuesClient.GetRepoLabels(nil)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch labels: %v", err), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string][]string{"labels": labels})
}

// handleGitLabRepoCollaborators — GET /api/gitlab/collaborators
func (s *Server) handleGitLabRepoCollaborators(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	collaborators, err := issuesClient.GetRepoCollaborators(nil)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch collaborators: %v", err), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string][]string{"collaborators": collaborators})
}

// handleGitHubAddComment — POST /api/github/issues/{n}/comment
func (s *Server) handleGitHubAddComment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	var payload struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		respondBadRequest(w, "Invalid request body")
		return
	}

	client, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	comment, err := client.AddComment(nil, number, payload.Body)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to add comment: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(comment)
}

// ─── Linked CRs Handlers ───────────────────────────────────────────────────

// handleGitHubIssueLinkedCRs — GET /api/github/issues/{n}/linked-crs
func (s *Server) handleGitHubIssueLinkedCRs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	mrs, err := issuesClient.GetIssueLinkedChangeRequests(nil, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch linked CRs: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(mrs)
}

// handleGitLabIssueLinkedCRs — GET /api/gitlab/issues/{n}/linked-crs
func (s *Server) handleGitLabIssueLinkedCRs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	mrs, err := issuesClient.GetIssueLinkedChangeRequests(nil, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch linked CRs: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(mrs)
}

// handleGitLabAddComment — POST /api/gitlab/issues/{n}/comment
func (s *Server) handleGitLabAddComment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	var payload struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		respondBadRequest(w, "Invalid request body")
		return
	}

	client, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	comment, err := client.AddComment(nil, number, payload.Body)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to add comment: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(comment)
}

// ─── CR Linked Issues Handlers ───────────────────────────────────────────

// handleGitHubCRLinkedIssues — GET /api/github/cr/{n}/linked-issues
func (s *Server) handleGitHubCRLinkedIssues(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, repoInfo, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	// Cast to concrete type to access GetChangeRequestLinkedIssues
	ghIssuesClient, ok := issuesClient.(*github.IssuesClient)
	if !ok {
		respondErrorMessage(w, "Failed to resolve GitHub issues client", http.StatusInternalServerError)
		return
	}

	issues, err := ghIssuesClient.GetChangeRequestLinkedIssues(repoInfo, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch linked issues: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issues)
}

// handleGitLabCRLinkedIssues — GET /api/gitlab/cr/{n}/linked-issues
func (s *Server) handleGitLabCRLinkedIssues(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, projectInfo, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	// Cast to concrete type to access GetChangeRequestLinkedIssues
	glIssuesClient, ok := issuesClient.(*gitlab.IssuesClient)
	if !ok {
		respondErrorMessage(w, "Failed to resolve GitLab issues client", http.StatusInternalServerError)
		return
	}

	issues, err := glIssuesClient.GetChangeRequestLinkedIssues(projectInfo, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch linked issues: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(issues)
}

// ─── Issue Referenced Issues Handlers ───────────────────────────────────────

// handleGitHubIssueReferencedIssues — GET /api/github/issues/{n}/references
func (s *Server) handleGitHubIssueReferencedIssues(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitHubIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	ghIssuesClient, ok := issuesClient.(*github.IssuesClient)
	if !ok {
		respondErrorMessage(w, "Failed to resolve GitHub issues client", http.StatusInternalServerError)
		return
	}

	referenced, err := ghIssuesClient.GetIssueReferencedIssues(nil, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch referenced issues: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(referenced)
}

// handleGitLabIssueReferencedIssues — GET /api/gitlab/issues/{n}/references
func (s *Server) handleGitLabIssueReferencedIssues(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	numberStr := r.URL.Query().Get("number")

	if appIdent == "" || numberStr == "" {
		respondBadRequest(w, "appIdent and number parameters required")
		return
	}

	number, err := strconv.Atoi(numberStr)
	if err != nil {
		respondBadRequest(w, "Invalid number")
		return
	}

	targetApp := s.findAppByIdent(appIdent)
	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	issuesClient, _, err := s.resolveGitLabIssueClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	glIssuesClient, ok := issuesClient.(*gitlab.IssuesClient)
	if !ok {
		respondErrorMessage(w, "Failed to resolve GitLab issues client", http.StatusInternalServerError)
		return
	}

	referenced, err := glIssuesClient.GetIssueReferencedIssues(nil, number)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch referenced issues: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(referenced)
}
