package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/gitlab"
)

func (s *Server) resolveGitLabClient(targetApp *app.App) (gitlab.Client, *gitlab.ProjectInfo, string, error) {
	return s.resolveGitLabClientWithContext(context.Background(), targetApp)
}

func (s *Server) resolveGitLabClientWithContext(ctx context.Context, targetApp *app.App) (gitlab.Client, *gitlab.ProjectInfo, string, error) {
	projectInfo, err := gitlab.ExtractProjectInfo(targetApp.RepositoryPath)
	if err != nil {
		return nil, nil, "", fmt.Errorf("failed to extract project info: %w", err)
	}
	providerName := targetApp.GetProviderName()
	username, token := "", ""
	if s.services.ProviderStore() != nil {
		username, token = s.services.ProviderStore().CredentialsFor(providerName)
	}
	if token == "" {
		return nil, nil, "", fmt.Errorf("no token configured for provider %q", providerName)
	}
	baseURL := fmt.Sprintf("https://%s", projectInfo.Host)
	client := gitlab.NewClientWithContext(ctx, baseURL, token, username)
	return client, projectInfo, username, nil
}

// handleGitLabChangeRequests fetches change requests for a given app
func (s *Server) handleGitLabChangeRequests(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	query := parseChangeRequestListQuery(r)

	if query.AppIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(query.AppIdent)

	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		respondBadRequest(w, "App has no repository path")
		return
	}

	// Get current branch
	currentBranch := s.services.GitRepository().GetCurrentBranch(&appAdapter{app: targetApp})
	if currentBranch == "" {
		currentBranch = targetApp.Branch // Fallback to configured branch
	}

	// Determine which branch to filter by
	if !query.AllBranches {
		isFeatureBranch := currentBranch != "develop" &&
			currentBranch != "master" &&
			currentBranch != "main" &&
			currentBranch != "qa" &&
			currentBranch != "quality"

		if !isFeatureBranch {
			respondBadRequest(w, fmt.Sprintf("Branch '%s' is not a feature branch. No change request to show.", currentBranch))
			return
		}
		query.Options.SourceBranch = currentBranch
	}
	query.Options.TargetBranch = "develop"

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	// Get change requests with pagination options via the changerequest.Client adapter
	mrClient := gitlab.NewMRClient(gitlabClient)
	result, err := mrClient.GetChangeRequests(projectInfo.ToChangeRequest(), &query.Options)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch change requests: %v", err), http.StatusInternalServerError)
		return
	}

	for i := range result.ChangeRequests {
		if result.ChangeRequests[i].DefaultBranch == "" {
			result.ChangeRequests[i].DefaultBranch = targetApp.MainWorktreeBranch
		}
	}

	// If no MRs found, return appropriate error
	if len(result.ChangeRequests) == 0 {
		var errorMsg string
		if query.AllBranches {
			errorMsg = "No open change requests found for this project"
		} else {
			errorMsg = fmt.Sprintf("No open change request found for branch '%s' → develop", currentBranch)
		}
		respondNotFound(w, errorMsg)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// handleGitLabPipelineJobs fetches jobs for a pipeline
func (s *Server) handleGitLabPipelineJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	// Get parameters from query
	appIdent := r.URL.Query().Get("appIdent")
	pipelineIDStr := r.URL.Query().Get("pipelineId")

	debugLog("Pipeline jobs request: appIdent=%s, pipelineId=%s", appIdent, pipelineIDStr)

	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	if pipelineIDStr == "" {
		respondBadRequest(w, "pipelineId parameter required")
		return
	}

	// Parse pipeline ID
	var pipelineID int
	if _, err := fmt.Sscanf(pipelineIDStr, "%d", &pipelineID); err != nil {
		respondBadRequest(w, "Invalid pipelineId")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(appIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", appIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", appIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	debugLog("Repository path: %s", targetApp.RepositoryPath)

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}

	debugLog("Project info: %s/%s on %s", projectInfo.Namespace, projectInfo.Project, projectInfo.Host)

	debugLog("Fetching jobs for pipeline %d from %s/%s", pipelineID, projectInfo.Namespace, projectInfo.Project)

	// Get jobs for pipeline
	jobs, err := gitlabClient.GetPipelineJobs(projectInfo, pipelineID)
	if err != nil {
		log.Printf("[ERROR] Failed to fetch pipeline jobs: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch pipeline jobs: %v", err), http.StatusInternalServerError)
		return
	}

	debugLog("Successfully fetched %d jobs", len(jobs))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(jobs)
}

// handleGitLabJobs is an alias for handleGitLabPipelineJobs for API consistency
func (s *Server) handleGitLabJobs(w http.ResponseWriter, r *http.Request) {
	s.handleGitLabPipelineJobs(w, r)
}

// handleGitLabTestSummary fetches test summary for a specific pipeline
func (s *Server) handleGitLabTestSummary(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	// Get parameters from query
	appIdent := r.URL.Query().Get("appIdent")
	pipelineIDStr := r.URL.Query().Get("pipelineId")

	debugLog("Test summary request: appIdent=%s, pipelineId=%s", appIdent, pipelineIDStr)

	if appIdent == "" || pipelineIDStr == "" {
		respondBadRequest(w, "appIdent and pipelineId parameters required")
		return
	}

	// Parse pipeline ID
	var pipelineID int
	if _, err := fmt.Sscanf(pipelineIDStr, "%d", &pipelineID); err != nil {
		respondBadRequest(w, "Invalid pipelineId")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(appIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", appIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", appIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}

	debugLog("Fetching test summary for pipeline %d", pipelineID)

	// Get test summary for pipeline
	testSummary, err := gitlabClient.GetTestSummary(projectInfo, pipelineID)
	if err != nil {
		log.Printf("[ERROR] Failed to fetch test summary: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch test summary: %v", err), http.StatusInternalServerError)
		return
	}

	debugLog("Test summary fetched successfully: %d total tests", testSummary.Total)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(testSummary)
}

// handleGitLabChangeRequestChanges fetches changed files for a specific change request
func (s *Server) handleGitLabChangeRequestChanges(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	// Get parameters from query
	appIdent := r.URL.Query().Get("appIdent")
	mrIIDStr := r.URL.Query().Get("crIID")

	debugLog("MR changes request: appIdent=%s, mrIID=%s", appIdent, mrIIDStr)

	if appIdent == "" || mrIIDStr == "" {
		respondBadRequest(w, "appIdent and crIID parameters required")
		return
	}

	// Parse MR IID
	var mrIID int
	if _, err := fmt.Sscanf(mrIIDStr, "%d", &mrIID); err != nil {
		respondBadRequest(w, "Invalid crIID")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(appIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", appIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", appIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}

	debugLog("Fetching MR changes for MR %d", mrIID)

	// Get MR changes
	changes, err := gitlabClient.GetChangeRequestChanges(projectInfo, mrIID)
	if err != nil {
		log.Printf("[ERROR] Failed to fetch MR changes: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch MR changes: %v", err), http.StatusInternalServerError)
		return
	}

	debugLog("MR changes fetched successfully: %d files changed", len(changes))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(changes)
}

// handleGitLabMRVersions fetches the versions (SHAs) for a change request
func (s *Server) handleGitLabMRVersions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	// Get parameters from query
	appIdent := r.URL.Query().Get("appIdent")
	mrIIDStr := r.URL.Query().Get("crIID")

	debugLog("MR versions request: appIdent=%s, mrIID=%s", appIdent, mrIIDStr)

	if appIdent == "" || mrIIDStr == "" {
		respondBadRequest(w, "appIdent and crIID parameters required")
		return
	}

	var mrIID int
	if _, err := fmt.Sscanf(mrIIDStr, "%d", &mrIID); err != nil {
		respondBadRequest(w, "Invalid crIID")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(appIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", appIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", appIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}

	debugLog("Fetching MR versions: project=%s/%s, MR=%d", projectInfo.Namespace, projectInfo.Project, mrIID)

	// Get MR versions
	versions, err := gitlabClient.GetMRVersions(projectInfo, mrIID)
	if err != nil {
		log.Printf("[ERROR] Failed to fetch MR versions: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch MR versions: %v", err), http.StatusInternalServerError)
		return
	}

	debugLog("Successfully fetched %d MR versions", len(versions))
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(versions)
}

// MRCommentRequest represents a request to create an MR comment
type MRCommentRequest struct {
	AppIdent string               `json:"appIdent"`
	MRIID    int                  `json:"crIID"`
	Body     string               `json:"body"`
	Position *gitlab.DiffPosition `json:"position,omitempty"`
}

// handleGitLabMRComment creates a new comment/discussion on a change request
func (s *Server) handleGitLabMRComment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	// Parse request body
	var req MRCommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, fmt.Sprintf("Invalid request body: %v", err))
		return
	}

	// Validate required fields
	if req.AppIdent == "" || req.MRIID == 0 || req.Body == "" {
		respondBadRequest(w, "appIdent, crIID, and body are required")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(req.AppIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", req.AppIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", req.AppIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}

	// Debug logging
	debugLog("Creating MR comment: project=%s/%s, MR=%d, body length=%d",
		projectInfo.Namespace, projectInfo.Project, req.MRIID, len(req.Body))
	if req.Position != nil {
		debugLog("Comment position: base_sha=%s, head_sha=%s, start_sha=%s, path=%s, new_line=%v, old_line=%v",
			req.Position.BaseSHA, req.Position.HeadSHA, req.Position.StartSHA,
			req.Position.NewPath, req.Position.NewLine, req.Position.OldLine)
	}

	// Create the comment
	err = gitlabClient.CreateMRDiffComment(projectInfo, req.MRIID, req.Body, req.Position)
	if err != nil {
		log.Printf("[ERROR] Failed to create MR comment: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to create comment: %v", err), http.StatusInternalServerError)
		return
	}

	// Return success
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Comment created successfully",
	})
}

// handleGitLabMRDiscussions fetches all discussions (comments) for a change request
func (s *Server) handleGitLabMRDiscussions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	// Get parameters from query
	appIdent := r.URL.Query().Get("appIdent")
	mrIIDStr := r.URL.Query().Get("crIID")

	debugLog("MR discussions request: appIdent=%s, mrIID=%s", appIdent, mrIIDStr)

	if appIdent == "" || mrIIDStr == "" {
		respondBadRequest(w, "appIdent and crIID parameters required")
		return
	}

	// Parse MR IID
	var mrIID int
	if _, err := fmt.Sscanf(mrIIDStr, "%d", &mrIID); err != nil {
		respondBadRequest(w, "Invalid crIID")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(appIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", appIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", appIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}

	debugLog("Fetching discussions for MR %d", mrIID)

	// Get MR discussions
	discussions, err := gitlabClient.GetMRDiscussions(projectInfo, mrIID)
	if err != nil {
		log.Printf("[ERROR] Failed to fetch MR discussions: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch discussions: %v", err), http.StatusInternalServerError)
		return
	}

	debugLog("Fetched %d discussions for MR %d", len(discussions), mrIID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(discussions)
}

// handleGitLabMRDiscussionReply adds a reply to an existing discussion
func (s *Server) handleGitLabMRDiscussionReply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	// Parse request body
	var req struct {
		AppIdent     string `json:"appIdent"`
		MRIID        int    `json:"crIID"`
		DiscussionID string `json:"discussionID"`
		Body         string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, fmt.Sprintf("Invalid request body: %v", err))
		return
	}

	debugLog("Discussion reply request: appIdent=%s, mrIID=%d, discussionID=%s", req.AppIdent, req.MRIID, req.DiscussionID)

	// Validate required fields
	if req.AppIdent == "" || req.MRIID == 0 || req.DiscussionID == "" || req.Body == "" {
		respondBadRequest(w, "appIdent, crIID, discussionID, and body are required")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(req.AppIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", req.AppIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", req.AppIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}

	debugLog("Adding reply to discussion %s on MR %d", req.DiscussionID, req.MRIID)

	// Add reply to discussion
	err = gitlabClient.ReplyToDiscussion(projectInfo, req.MRIID, req.DiscussionID, req.Body)
	if err != nil {
		log.Printf("[ERROR] Failed to add reply: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to add reply: %v", err), http.StatusInternalServerError)
		return
	}

	debugLog("Reply added successfully")

	// Return success
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Reply added successfully",
	})
}

// handleGitLabMRDiscussionResolve resolves or unresolves a discussion thread
func (s *Server) handleGitLabMRDiscussionResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	// Parse request body
	var req struct {
		AppIdent     string `json:"appIdent"`
		MRIID        int    `json:"crIID"`
		DiscussionID string `json:"discussionID"`
		Resolved     bool   `json:"resolved"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, fmt.Sprintf("Invalid request body: %v", err))
		return
	}

	debugLog("Discussion resolve request: appIdent=%s, mrIID=%d, discussionID=%s, resolved=%t", req.AppIdent, req.MRIID, req.DiscussionID, req.Resolved)

	// Validate required fields
	if req.AppIdent == "" || req.MRIID == 0 || req.DiscussionID == "" {
		respondBadRequest(w, "appIdent, crIID, and discussionID are required")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(req.AppIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", req.AppIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", req.AppIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}

	action := "Resolving"
	if !req.Resolved {
		action = "Unresolving"
	}
	debugLog("%s discussion %s on MR %d", action, req.DiscussionID, req.MRIID)

	// Resolve/unresolve discussion
	err = gitlabClient.ResolveDiscussion(projectInfo, req.MRIID, req.DiscussionID, req.Resolved)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve discussion: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to resolve discussion: %v", err), http.StatusInternalServerError)
		return
	}

	debugLog("Discussion resolved successfully")

	// Return success
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Discussion resolved successfully",
	})
}

// handleGitLabMRApprove approves a change request
func (s *Server) handleGitLabMRApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	// Get parameters from query
	appIdent := r.URL.Query().Get("appIdent")
	mrIIDStr := r.URL.Query().Get("crIID")

	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	if mrIIDStr == "" {
		respondBadRequest(w, "crIID parameter required")
		return
	}

	// Parse MR IID
	var mrIID int
	if _, err := fmt.Sscanf(mrIIDStr, "%d", &mrIID); err != nil {
		respondBadRequest(w, "Invalid crIID")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(appIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", appIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", appIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}

	log.Printf("[INFO] Approving change request: project=%s/%s, MR=!%d",
		projectInfo.Namespace, projectInfo.Project, mrIID)

	// Approve the change request
	err = gitlabClient.ApproveChangeRequest(projectInfo, mrIID)
	if err != nil {
		log.Printf("[ERROR] Failed to approve change request: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to approve change request: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[INFO] Merge request approved successfully: !%d", mrIID)

	// Return success
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Merge request approved successfully",
	})
}

// handleGitLabMRUnapprove removes approval from a change request
func (s *Server) handleGitLabMRUnapprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	// Get parameters from query
	appIdent := r.URL.Query().Get("appIdent")
	mrIIDStr := r.URL.Query().Get("crIID")

	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	if mrIIDStr == "" {
		respondBadRequest(w, "crIID parameter required")
		return
	}

	// Parse MR IID
	var mrIID int
	if _, err := fmt.Sscanf(mrIIDStr, "%d", &mrIID); err != nil {
		respondBadRequest(w, "Invalid crIID")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(appIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", appIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", appIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}

	log.Printf("[INFO] Unapproving change request: project=%s/%s, MR=!%d",
		projectInfo.Namespace, projectInfo.Project, mrIID)

	// Unapprove the change request
	err = gitlabClient.UnapproveChangeRequest(projectInfo, mrIID)
	if err != nil {
		log.Printf("[ERROR] Failed to unapprove change request: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to unapprove change request: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[INFO] Merge request unapproved successfully: !%d", mrIID)

	// Return success
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Merge request unapproved successfully",
	})
}

// handleGitLabMRToggleApproval toggles the approval status of a change request
// Uses the backend config to determine current user and automatically approve/unapprove
func (s *Server) handleGitLabMRToggleApproval(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	// Get parameters from query
	appIdent := r.URL.Query().Get("appIdent")
	mrIIDStr := r.URL.Query().Get("crIID")

	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	if mrIIDStr == "" {
		respondBadRequest(w, "crIID parameter required")
		return
	}

	// Parse MR IID
	var mrIID int
	if _, err := fmt.Sscanf(mrIIDStr, "%d", &mrIID); err != nil {
		respondBadRequest(w, "Invalid crIID")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(appIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", appIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", appIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, username, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}
	if username == "" {
		log.Printf("[ERROR] GitLab username not configured")
		respondBadRequest(w, "GitLab username not configured")
		return
	}

	log.Printf("[INFO] Toggling approval for change request: project=%s/%s, MR=!%d, user=%s",
		projectInfo.Namespace, projectInfo.Project, mrIID, username)

	// Toggle the approval (backend determines whether to approve or unapprove)
	err = gitlabClient.ToggleMRApproval(projectInfo, mrIID, username)
	if err != nil {
		log.Printf("[ERROR] Failed to toggle change request approval: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to toggle approval: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[INFO] Merge request approval toggled successfully: !%d", mrIID)

	// Return success
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Merge request approval toggled successfully",
	})
}

func (s *Server) handleGitLabMRRebase(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	// Get parameters from query
	appIdent := r.URL.Query().Get("appIdent")
	mrIIDStr := r.URL.Query().Get("crIID")

	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	if mrIIDStr == "" {
		respondBadRequest(w, "crIID parameter required")
		return
	}

	// Parse MR IID
	var mrIID int
	if _, err := fmt.Sscanf(mrIIDStr, "%d", &mrIID); err != nil {
		respondBadRequest(w, "Invalid crIID")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(appIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", appIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", appIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}

	log.Printf("[INFO] Rebasing change request: project=%s/%s, MR=!%d",
		projectInfo.Namespace, projectInfo.Project, mrIID)

	// Rebase the change request
	err = gitlabClient.RebaseChangeRequest(projectInfo, mrIID)
	if err != nil {
		log.Printf("[ERROR] Failed to rebase change request: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to rebase change request: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[INFO] Merge request rebase triggered successfully: !%d", mrIID)

	// Return success
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Merge request rebase triggered successfully",
	})
}

// handleGitLabJobLogs fetches logs for a specific job
func (s *Server) handleGitLabJobLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	// Get parameters from query
	appIdent := r.URL.Query().Get("appIdent")
	jobIDStr := r.URL.Query().Get("jobId")

	debugLog("Job logs request: appIdent=%s, jobId=%s", appIdent, jobIDStr)

	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	if jobIDStr == "" {
		respondBadRequest(w, "jobId parameter required")
		return
	}

	// Parse job ID
	var jobID int
	if _, err := fmt.Sscanf(jobIDStr, "%d", &jobID); err != nil {
		respondBadRequest(w, "Invalid jobId")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(appIdent)

	if targetApp == nil {
		log.Printf("[ERROR] App not found: %s", appIdent)
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		log.Printf("[ERROR] App has no repository path: %s", appIdent)
		respondBadRequest(w, "App has no repository path")
		return
	}

	debugLog("Repository path: %s", targetApp.RepositoryPath)

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		log.Printf("[ERROR] Failed to resolve GitLab client: %v", err)
		respondBadRequest(w, err.Error())
		return
	}

	debugLog("Project info: %s/%s on %s", projectInfo.Namespace, projectInfo.Project, projectInfo.Host)

	debugLog("Fetching logs for job %d from %s/%s", jobID, projectInfo.Namespace, projectInfo.Project)

	// Get logs for job
	logs, err := gitlabClient.GetJobLogsContext(r.Context(), projectInfo, jobID)
	if err != nil {
		log.Printf("[ERROR] Failed to fetch job logs: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch job logs: %v", err), http.StatusInternalServerError)
		return
	}

	debugLog("Successfully fetched %d bytes of logs", len(logs))

	// Return logs as plain text
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(logs))
}

// handleGitLabJobRetry retries/restarts a specific job
func (s *Server) handleGitLabJobRetry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	jobIDStr := r.URL.Query().Get("jobId")

	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	if jobIDStr == "" {
		respondBadRequest(w, "jobId parameter required")
		return
	}

	// Parse job ID
	var jobID int
	if _, err := fmt.Sscanf(jobIDStr, "%d", &jobID); err != nil {
		respondBadRequest(w, "Invalid jobId")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(appIdent)

	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	log.Printf("[INFO] Retrying job %d for app %s", jobID, appIdent)

	// Restart the job
	err = gitlabClient.RestartJob(projectInfo, jobID)
	if err != nil {
		log.Printf("[ERROR] Failed to retry job %d: %v", jobID, err)
		respondErrorMessage(w, fmt.Sprintf("Failed to retry job: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[INFO] Job %d restarted successfully", jobID)

	// Broadcast event
	s.BroadcastEvent(Event{
		Type: "gitlab.job.retried",
		Properties: map[string]interface{}{
			"appIdent": appIdent,
			"jobId":    jobID,
		},
		Timestamp: time.Now(),
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"jobId":   jobID,
		"action":  "retry",
	})
}

// handleGitLabJobCancel cancels/aborts a specific job
func (s *Server) handleGitLabJobCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	jobIDStr := r.URL.Query().Get("jobId")

	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	if jobIDStr == "" {
		respondBadRequest(w, "jobId parameter required")
		return
	}

	// Parse job ID
	var jobID int
	if _, err := fmt.Sscanf(jobIDStr, "%d", &jobID); err != nil {
		respondBadRequest(w, "Invalid jobId")
		return
	}

	// Find the app
	var targetApp *app.App
	targetApp = s.findAppByIdent(appIdent)

	if targetApp == nil {
		respondNotFound(w, "App not found")
		return
	}

	if targetApp.RepositoryPath == "" {
		respondBadRequest(w, "App has no repository path")
		return
	}

	gitlabClient, projectInfo, _, err := s.resolveGitLabClientWithContext(r.Context(), targetApp)
	if err != nil {
		respondBadRequest(w, err.Error())
		return
	}

	log.Printf("[INFO] Cancelling job %d for app %s", jobID, appIdent)

	// Cancel the job
	err = gitlabClient.CancelJob(projectInfo, jobID)
	if err != nil {
		log.Printf("[ERROR] Failed to cancel job %d: %v", jobID, err)
		respondErrorMessage(w, fmt.Sprintf("Failed to cancel job: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[INFO] Job %d cancelled successfully", jobID)

	// Broadcast event
	s.BroadcastEvent(Event{
		Type: "gitlab.job.cancelled",
		Properties: map[string]interface{}{
			"appIdent": appIdent,
			"jobId":    jobID,
		},
		Timestamp: time.Now(),
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"jobId":   jobID,
		"action":  "cancel",
	})
}
