package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	git "github.com/friendsfriend/devenv/pkg/git"
)

// handleGitPull performs a git pull operation on an app's repository
func (s *Server) handleGitPull(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	// Find the app
	appObj := s.findApp(appIdent)
	if appObj == nil {
		respondNotFound(w, "App not found")
		return
	}

	log.Printf("[INFO] Git pull started for app: %s", appIdent)

	// Set operation status to active
	s.setOperationStatus(appIdent, "pull", "active", "Pulling...")

	// Perform pull operation
	err := s.runGitAction(appIdent, fmt.Sprintf("Git pull %s", appIdent), "git.pull", appObj.GetBranch(), func() error {
		return s.services.GitRepository().Pull(appObj)
	})
	if err != nil {
		log.Printf("[ERROR] Git pull failed for %s: %v", appIdent, err)
		// Set operation status to failed
		s.setOperationStatus(appIdent, "pull", "failed", fmt.Sprintf("Pull failed: %v", err))
		// Auto-clear after 3 seconds
		go func() {
			time.Sleep(3 * time.Second)
			s.clearOperationStatus(appIdent)
		}()
		respondErrorMessage(w, fmt.Sprintf("Git pull failed: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[INFO] Git pull completed successfully for app: %s", appIdent)

	// Set operation status to completed
	s.setOperationStatus(appIdent, "pull", "completed", "Pull completed")
	// Auto-clear after 2 seconds
	go func() {
		time.Sleep(2 * time.Second)
		s.clearOperationStatus(appIdent)
	}()

	// Broadcast Git event
	s.BroadcastEvent(Event{
		Type: "git.pull.completed",
		Properties: map[string]interface{}{
			"appIdent": appIdent,
		},
		Timestamp: time.Now(),
	})

	// Immediately broadcast updated Git status
	s.broadcastAppStatus(appIdent)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"appIdent": appIdent,
		"action":   "pull",
	})
}

// handleGitPush performs a git push operation on an app's repository
func (s *Server) handleGitPush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	// Find the app
	appObj := s.findApp(appIdent)
	if appObj == nil {
		respondNotFound(w, "App not found")
		return
	}

	log.Printf("[INFO] Git push started for app: %s", appIdent)

	// Set operation status to active
	s.setOperationStatus(appIdent, "push", "active", "Pushing...")

	// Perform push operation
	err := s.runGitAction(appIdent, fmt.Sprintf("Git push %s", appIdent), "git.push", appObj.GetBranch(), func() error {
		return s.services.GitRepository().Push(appObj)
	})
	if err != nil {
		log.Printf("[ERROR] Git push failed for %s: %v", appIdent, err)
		// Set operation status to failed
		s.setOperationStatus(appIdent, "push", "failed", fmt.Sprintf("Push failed: %v", err))
		// Auto-clear after 3 seconds
		go func() {
			time.Sleep(3 * time.Second)
			s.clearOperationStatus(appIdent)
		}()
		respondErrorMessage(w, fmt.Sprintf("Git push failed: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[INFO] Git push completed successfully for app: %s", appIdent)

	// Set operation status to completed
	s.setOperationStatus(appIdent, "push", "completed", "Push completed")
	// Auto-clear after 2 seconds
	go func() {
		time.Sleep(2 * time.Second)
		s.clearOperationStatus(appIdent)
	}()

	// Broadcast Git event
	s.BroadcastEvent(Event{
		Type: "git.push.completed",
		Properties: map[string]interface{}{
			"appIdent": appIdent,
		},
		Timestamp: time.Now(),
	})

	// Immediately broadcast updated Git status
	s.broadcastAppStatus(appIdent)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"appIdent": appIdent,
		"action":   "push",
	})
}

// handleGitFetch performs a git fetch operation on an app's repository
func (s *Server) handleGitFetch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	// Find the app
	appObj := s.findApp(appIdent)
	if appObj == nil {
		respondNotFound(w, "App not found")
		return
	}

	log.Printf("[INFO] Git fetch started for app: %s", appIdent)

	// Set operation status to active
	s.setOperationStatus(appIdent, "fetch", "active", "Fetching...")

	// Perform fetch operation
	err := s.runGitAction(appIdent, fmt.Sprintf("Git fetch %s", appIdent), "git.fetch", appObj.GetBranch(), func() error {
		return s.services.GitRepository().Fetch(appObj)
	})
	if err != nil {
		log.Printf("[ERROR] Git fetch failed for %s: %v", appIdent, err)
		// Set operation status to failed
		s.setOperationStatus(appIdent, "fetch", "failed", fmt.Sprintf("Fetch failed: %v", err))
		// Auto-clear after 3 seconds
		go func() {
			time.Sleep(3 * time.Second)
			s.clearOperationStatus(appIdent)
		}()
		respondErrorMessage(w, fmt.Sprintf("Git fetch failed: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[INFO] Git fetch completed successfully for app: %s", appIdent)

	// Set operation status to completed
	s.setOperationStatus(appIdent, "fetch", "completed", "Fetch completed")
	// Auto-clear after 2 seconds
	go func() {
		time.Sleep(2 * time.Second)
		s.clearOperationStatus(appIdent)
	}()

	// Broadcast Git event
	s.BroadcastEvent(Event{
		Type: "git.fetch.completed",
		Properties: map[string]interface{}{
			"appIdent": appIdent,
		},
		Timestamp: time.Now(),
	})

	// Immediately broadcast updated Git status
	s.broadcastAppStatus(appIdent)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"appIdent": appIdent,
		"action":   "fetch",
	})
}

// handleGitBranches returns all branches for an app
func (s *Server) handleGitBranches(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	// Find the app
	appObj := s.findApp(appIdent)
	if appObj == nil {
		respondNotFound(w, "App not found")
		return
	}

	log.Printf("[INFO] Fetching branches for app: %s", appIdent)

	// Get local branches
	localBranches, err := s.services.GitRepository().GetLocalBranches(appObj)
	if err != nil {
		log.Printf("[WARN] Failed to get local branches for %s (repo may not be cloned yet): %v", appIdent, err)
		// If the local repository doesn't exist yet, treat it as having no local branches
		// so the selector can still show remote branches and allow checkout/clone
		localBranches = []string{}
	}

	// Get remote branches
	var fetchError string
	remoteBranches, err := s.services.GitRepository().GetBranches(appObj.GetRepositoryPath())
	if err != nil {
		log.Printf("[ERROR] Failed to get remote branches for %s: %v", appIdent, err)
		fetchError = err.Error()
		remoteBranches = []string{}
	}

	// Get current branch
	currentBranch := s.services.GitRepository().GetCurrentBranch(appObj)

	log.Printf("[INFO] Found %d local branches, %d remote branches for %s", len(localBranches), len(remoteBranches), appIdent)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"appIdent":       appIdent,
		"currentBranch":  currentBranch,
		"localBranches":  localBranches,
		"remoteBranches": remoteBranches,
		"error":          fetchError,
	})
}

// handleGitCheckout performs a git checkout operation to switch branches
func (s *Server) handleGitCheckout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	appIdent := r.URL.Query().Get("appIdent")
	branch := r.URL.Query().Get("branch")

	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}

	if branch == "" {
		respondBadRequest(w, "branch parameter required")
		return
	}

	// Reload app config from disk before processing so that any manual edits
	// to definition files (e.g. changing gitMode) are always picked up
	// without requiring a server restart.
	s.reloadAppConfig()

	// Find the app
	appObj := s.findApp(appIdent)
	if appObj == nil {
		respondNotFound(w, "App not found")
		return
	}

	log.Printf("[INFO] Git checkout started for app %s to branch %s", appIdent, branch)

	// Set operation status to active
	s.setOperationStatus(appIdent, "checkout", "active", fmt.Sprintf("Checking out %s...", branch))

	// Perform checkout operation
	err := s.runGitAction(appIdent, fmt.Sprintf("Git checkout %s", branch), "git.checkout", branch, func() error {
		return s.services.GitRepository().Checkout(appObj, branch)
	})
	if err != nil {
		log.Printf("[ERROR] Git checkout failed for %s to %s: %v", appIdent, branch, err)
		s.setOperationStatus(appIdent, "checkout", "failed", fmt.Sprintf("Checkout failed: %v", err))
		go func() {
			time.Sleep(3 * time.Second)
			s.clearOperationStatus(appIdent)
		}()
		respondErrorMessage(w, fmt.Sprintf("Git checkout failed: %v", err), http.StatusInternalServerError)
		return
	}

	// Always reload after checkout so the latest state is reflected in all
	// subsequent requests regardless of worktree mode.
	s.reloadAppConfig()

	log.Printf("[INFO] Git checkout completed successfully for app %s to branch %s", appIdent, branch)

	// Set operation status to completed
	s.setOperationStatus(appIdent, "checkout", "completed", fmt.Sprintf("Checked out %s", branch))
	// Auto-clear after 2 seconds
	go func() {
		time.Sleep(2 * time.Second)
		s.clearOperationStatus(appIdent)
	}()

	// Broadcast Git event
	s.BroadcastEvent(Event{
		Type: "git.checkout.completed",
		Properties: map[string]interface{}{
			"appIdent": appIdent,
			"branch":   branch,
		},
		Timestamp: time.Now(),
	})

	// Immediately broadcast updated Git status (branch changed).
	// Use broadcastAppStatusWithBranch so the newly active branch is included
	// even when the linked-worktree HEAD file is not yet readable on disk.
	s.broadcastAppStatusWithBranch(appIdent, branch)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"appIdent": appIdent,
		"action":   "checkout",
		"branch":   branch,
	})
}

// handleWorktrees dispatches GET (list), POST (create), PATCH (switch active), and DELETE (remove) for worktree operations.
func (s *Server) handleWorktrees(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleListWorktrees(w, r)
	case http.MethodPost:
		s.handleCreateWorktree(w, r)
	case http.MethodPatch:
		s.handleSwitchWorktree(w, r)
	case http.MethodDelete:
		s.handleRemoveWorktree(w, r)
	default:
		respondMethodNotAllowed(w)
	}
}

// handleListWorktrees returns all worktrees for a worktree-mode app.
func (s *Server) handleListWorktrees(w http.ResponseWriter, r *http.Request) {
	appIdent := r.URL.Query().Get("appIdent")
	if appIdent == "" {
		respondBadRequest(w, "appIdent parameter required")
		return
	}
	appObj := s.findApp(appIdent)
	if appObj == nil {
		respondNotFound(w, "App not found")
		return
	}
	worktrees, err := s.services.GitRepository().ListWorktrees(appObj)
	if err != nil {
		respondInternalError(w, err)
		return
	}
	if worktrees == nil {
		worktrees = []git.WorktreeInfo{}
	}
	respondJSON(w, map[string]interface{}{"worktrees": worktrees}, http.StatusOK)
}

// handleRemoveWorktree removes a linked worktree for a worktree-mode app.
func (s *Server) handleRemoveWorktree(w http.ResponseWriter, r *http.Request) {
	appIdent := r.URL.Query().Get("appIdent")
	branch := r.URL.Query().Get("branch")
	if appIdent == "" || branch == "" {
		respondBadRequest(w, "appIdent and branch parameters required")
		return
	}
	appObj := s.findApp(appIdent)
	if appObj == nil {
		respondNotFound(w, "App not found")
		return
	}
	if branch == appObj.app.ActiveWorktree || branch == appObj.app.MainWorktreeBranch {
		respondBadRequest(w, "cannot remove the active or primary worktree")
		return
	}
	if err := s.runGitAction(appIdent, fmt.Sprintf("Remove worktree %s", branch), "git.worktree.remove", branch, func() error {
		return s.services.GitRepository().RemoveWorktree(appObj, branch)
	}); err != nil {
		respondInternalError(w, err)
		return
	}
	log.Printf("[INFO] Removed worktree for app %s branch %s", appIdent, branch)
	respondJSON(w, map[string]interface{}{"success": true}, http.StatusOK)
}

// handleCreateWorktree creates a new linked worktree for an app and sets it as the active worktree.
func (s *Server) handleCreateWorktree(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AppIdent string `json:"appIdent"`
		Branch   string `json:"branch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, fmt.Sprintf("Invalid request body: %v", err))
		return
	}
	if req.AppIdent == "" || req.Branch == "" {
		respondBadRequest(w, "appIdent and branch are required")
		return
	}
	appObj := s.findApp(req.AppIdent)
	if appObj == nil {
		respondNotFound(w, "App not found")
		return
	}
	if _, err := func() (string, error) {
		var path string
		err := s.runGitAction(req.AppIdent, fmt.Sprintf("Create worktree %s", req.Branch), "git.worktree.create", req.Branch, func() error {
			var inner error
			path, inner = s.services.GitRepository().AddWorktree(appObj, req.Branch)
			return inner
		})
		return path, err
	}(); err != nil {
		log.Printf("[ERROR] Failed to add worktree for app %s branch %s: %v", req.AppIdent, req.Branch, err)
		respondInternalError(w, err)
		return
	}
	if err := s.services.AppManager().UpdateAppActiveWorktree(req.AppIdent, req.Branch); err != nil {
		log.Printf("[WARN] Failed to persist active worktree for %s: %v", req.AppIdent, err)
	}
	s.reloadAppConfig()
	log.Printf("[INFO] Created worktree for app %s branch %s", req.AppIdent, req.Branch)
	s.broadcastAppStatusWithBranch(req.AppIdent, req.Branch)
	respondJSON(w, map[string]interface{}{"success": true, "appIdent": req.AppIdent, "branch": req.Branch}, http.StatusCreated)
}

// handleSwitchWorktree sets an existing linked worktree as the active one without
// performing any git operation — the worktree directory already exists on disk.
func (s *Server) handleSwitchWorktree(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AppIdent string `json:"appIdent"`
		Branch   string `json:"branch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, fmt.Sprintf("Invalid request body: %v", err))
		return
	}
	if req.AppIdent == "" || req.Branch == "" {
		respondBadRequest(w, "appIdent and branch are required")
		return
	}
	appObj := s.findApp(req.AppIdent)
	if appObj == nil {
		respondNotFound(w, "App not found")
		return
	}
	if err := s.services.AppManager().UpdateAppActiveWorktree(req.AppIdent, req.Branch); err != nil {
		log.Printf("[WARN] Failed to persist active worktree for %s: %v", req.AppIdent, err)
		respondInternalError(w, err)
		return
	}
	s.reloadAppConfig()
	log.Printf("[INFO] Switched active worktree for app %s to branch %s", req.AppIdent, req.Branch)
	s.broadcastAppStatusWithBranch(req.AppIdent, req.Branch)
	respondJSON(w, map[string]interface{}{"success": true, "appIdent": req.AppIdent, "branch": req.Branch}, http.StatusOK)
}
