package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/docker"
	"github.com/friendsfriend/devenv/pkg/github"
	"github.com/friendsfriend/devenv/pkg/gitlab"
	"github.com/friendsfriend/devenv/pkg/provider"
)

// handleGetApps returns all applications (metadata only, no status)
func (s *Server) handleGetApps(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	apps := make([]AppResponse, 0, len(s.apps))
	for _, a := range s.apps {
		apps = append(apps, AppResponse{
			Ident:              a.Ident,
			DisplayName:        a.DisplayName,
			LocalDirectoryPath: a.LocalDirectoryPath,
			RepositoryPath:     a.RepositoryPath,
			Branch:             a.Branch,
			AppType:            a.AppType,
			ContainerBaseName:  a.GetContainerBaseName(),
			SourceType:         s.resolveSourceTypeForApp(a),
			Provider:           a.Provider,
			ActiveWorktree:     a.ActiveWorktree,
			MainWorktreeBranch: a.MainWorktreeBranch,
		})
	}

	respondJSON(w, map[string]interface{}{
		"apps": apps,
	}, http.StatusOK)
}

// handleGetInfraServices returns all infrastructure services with Docker status
func (s *Server) handleGetInfraServices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	dockerClient := s.services.DockerClient()

	infraServices := s.infraServices
	responses := make([]InfraServiceResponse, 0, len(infraServices))

	// Prepare Docker infrastructure adapters only; script services use script lifecycle state.
	infraAdapters := make([]docker.InfraService, 0, len(infraServices))
	for i := range infraServices {
		if infraServices[i].Type == "" || infraServices[i].Type == app.InfraServiceTypeDocker {
			infraAdapters = append(infraAdapters, &infraServiceAdapter{service: &infraServices[i]})
		}
	}

	dockerInfoMap, err := dockerClient.BatchGetInfo(nil, infraAdapters)
	if err != nil {
		log.Printf("Error fetching Docker status for infrastructure services: %v", err)
	}

	for _, svc := range infraServices {
		var dockerInfo *docker.Info
		if info, exists := dockerInfoMap[svc.Ident]; exists {
			dockerInfo = &info
		}
		snapshot := s.resolveInfrastructureStatus(svc, dockerInfo)

		s.opStatusMu.RLock()
		opStatus := s.opStatus[svc.Ident]
		s.opStatusMu.RUnlock()

		responses = append(responses, InfraServiceResponse{
			Ident:             svc.Ident,
			ResourceID:        svc.Ident,
			ResourceKind:      "infrastructure",
			DisplayName:       svc.DisplayName,
			Type:              svc.Type,
			ContainerBaseName: svc.GetContainerBaseName(),
			DockerInfo:        snapshot.dockerInfo,
			RuntimeStatus:     &snapshot.runtimeStatus,
			Status:            snapshot.runtimeStatus.String(),
			LogPath:           snapshot.logPath,
			ShellPath:         svc.ShellPath,
			PowerShellPath:    svc.PowerShellPath,
			DefaultRunner:     svc.DefaultRunner,
			OperationStatus:   opStatus,
			ExecutionHandle:   snapshot.executionHandle,
		})
	}

	respondJSON(w, map[string]interface{}{
		"services": responses,
	}, http.StatusOK)
}

// handleGetStatus returns status for all applications (Docker + Git info)
func (s *Server) handleGetStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	dockerClient := s.services.DockerClient()
	gitRepo := s.services.GitRepository()

	appAdapters := make([]docker.App, 0, len(s.apps))
	for idx := range s.apps {
		if s.apps[idx].AppType == app.TypeAPP {
			appAdapters = append(appAdapters, &appAdapter{app: &s.apps[idx]})
		}
	}

	dockerInfoMap, err := dockerClient.BatchGetInfo(appAdapters, nil)
	if err != nil {
		log.Printf("Error fetching Docker status: %v", err)
		respondInternalError(w, err)
		return
	}

	statuses := make([]AppStatusResponse, 0, len(s.apps))
	for _, a := range s.apps {
		var dockerInfo *docker.Info
		observedDocker := docker.Info{Status: "not found"}
		if info, ok := dockerInfoMap[a.Ident]; ok {
			dockerInfo = &info
			observedDocker = info
		}
		gitStatus := gitRepo.GetStatus(&appAdapter{app: &a})
		currentBranch := gitRepo.GetCurrentBranch(&appAdapter{app: &a})
		opStatus := s.getOperationStatus(a.Ident)

		appRunStatus := s.appRuntimeStatus(a, observedDocker)
		legacyStatus := ""
		if appRunStatus != nil {
			legacyStatus = appRunStatus.String()
		}
		resp := AppStatusResponse{
			Ident:           a.Ident,
			ResourceID:      a.Ident,
			ResourceKind:    appResourceKind(a),
			DockerInfo:      dockerInfo,
			GitStatus:       gitStatus,
			Branch:          currentBranch,
			ActiveWorktree:  a.ActiveWorktree,
			OperationStatus: opStatus,
			RuntimeStatus:   appRunStatus,
			Status:          legacyStatus,
		}
		if s.services != nil && s.services.BuildService() != nil {
			if info, ok := s.services.BuildService().RunTargetInfo(a.Ident); ok {
				resp.RunTargetInfo = info
			}
		}
		statuses = append(statuses, resp)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"statuses": statuses,
	})
}

// handleGetDockerInfo returns docker info for an app
func (s *Server) handleGetDockerInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	ident := r.PathValue("ident")
	appObj := s.findApp(ident)
	if appObj == nil {
		respondNotFound(w, "App not found")
		return
	}

	info := s.services.DockerClient().GetInfo(appObj)

	respondJSON(w, info, http.StatusOK)
}

// handleGetGitInfo returns git branch and status information for an app.
func (s *Server) handleGetGitInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	ident := r.PathValue("ident")
	appObj := s.findApp(ident)
	if appObj == nil {
		respondNotFound(w, "App not found")
		return
	}

	branch := s.services.GitRepository().GetCurrentBranch(appObj)
	gitStatus := s.services.GitRepository().GetStatus(appObj)

	info := map[string]string{
		"branch": branch,
		"status": gitStatus,
	}

	respondJSON(w, info, http.StatusOK)
}

// handleProviders handles CRUD operations for git provider credentials.
// GET returns all providers (tokens hidden), POST creates a new provider.
func (s *Server) handleProviders(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		if err := s.services.ProviderStore().Load(); err != nil {
			respondInternalError(w, fmt.Errorf("failed to reload providers: %w", err))
			return
		}
		providers := s.services.ProviderStore().List()
		invalidProviders := s.services.ProviderStore().InvalidProviders()
		type providerResponse struct {
			Name        string   `json:"name"`
			Type        string   `json:"type"`
			Username    string   `json:"username"`
			HasToken    bool     `json:"has_token"`
			MissingVars []string `json:"missing_vars,omitempty"`
			Invalid     bool     `json:"invalid,omitempty"`
			Reason      string   `json:"reason,omitempty"`
			Message     string   `json:"message,omitempty"`
		}
		result := make([]providerResponse, 0, len(providers)+len(invalidProviders))
		for _, p := range providers {
			result = append(result, providerResponse{
				Name:        p.Name,
				Type:        p.Type,
				Username:    p.Username,
				HasToken:    p.Token != "",
				MissingVars: p.MissingVars,
			})
		}
		for _, p := range invalidProviders {
			result = append(result, providerResponse{
				Name:    p.Name,
				Type:    p.Type,
				Invalid: true,
				Reason:  p.Reason,
				Message: p.Message,
			})
		}
		respondJSON(w, result, http.StatusOK)

	case http.MethodPost:
		var req provider.Provider
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondBadRequest(w, fmt.Sprintf("Invalid request body: %v", err))
			return
		}
		if err := s.services.ProviderStore().Save(req); err != nil {
			respondErrorMessage(w, err.Error(), http.StatusBadRequest)
			return
		}
		s.BroadcastEvent(Event{
			Type:       "providers.updated",
			Properties: map[string]interface{}{},
			Timestamp:  time.Now(),
		})
		respondJSON(w, map[string]interface{}{"success": true}, http.StatusCreated)

	default:
		respondMethodNotAllowed(w)
	}
}

// handleProviderByName handles GET, PUT, DELETE for a specific provider by name.
func (s *Server) handleProviderByName(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/api/providers/")
	if name == "" {
		respondBadRequest(w, "provider name required")
		return
	}

	switch r.Method {
	case http.MethodGet:
		p, ok := s.services.ProviderStore().Get(name)
		if !ok {
			respondNotFound(w, fmt.Sprintf("Provider %q not found", name))
			return
		}
		resp := map[string]interface{}{
			"name":      p.Name,
			"type":      p.Type,
			"username":  p.Username,
			"has_token": p.Token != "",
		}
		if len(p.MissingVars) > 0 {
			resp["missing_vars"] = p.MissingVars
		}
		respondJSON(w, resp, http.StatusOK)

	case http.MethodPut:
		var req provider.Provider
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondBadRequest(w, fmt.Sprintf("Invalid request body: %v", err))
			return
		}
		req.Name = name
		if err := s.services.ProviderStore().Save(req); err != nil {
			respondErrorMessage(w, err.Error(), http.StatusBadRequest)
			return
		}
		s.BroadcastEvent(Event{
			Type:       "providers.updated",
			Properties: map[string]interface{}{},
			Timestamp:  time.Now(),
		})
		respondJSON(w, map[string]interface{}{"success": true}, http.StatusOK)

	case http.MethodDelete:
		if err := s.services.ProviderStore().Delete(name); err != nil {
			respondErrorMessage(w, err.Error(), http.StatusBadRequest)
			return
		}
		s.BroadcastEvent(Event{
			Type:       "providers.updated",
			Properties: map[string]interface{}{},
			Timestamp:  time.Now(),
		})
		respondJSON(w, map[string]interface{}{"success": true}, http.StatusOK)

	default:
		respondMethodNotAllowed(w)
	}
}

// handleRepoSearch searches for repositories using the specified provider.
func (s *Server) handleRepoSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	type requestBody struct {
		Provider string `json:"provider"`
		Query    string `json:"query"`
		Host     string `json:"host"`
	}
	type repoSearchResult struct {
		Name          string `json:"name"`
		FullPath      string `json:"fullPath"`
		URL           string `json:"url"`
		DefaultBranch string `json:"defaultBranch"`
	}

	var req requestBody
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, fmt.Sprintf("Invalid request body: %v", err))
		return
	}

	req.Provider = strings.TrimSpace(req.Provider)
	req.Query = strings.TrimSpace(req.Query)
	req.Host = strings.TrimSpace(req.Host)

	if req.Provider == "" || req.Query == "" {
		respondBadRequest(w, "provider and query are required")
		return
	}

	p, ok := s.services.ProviderStore().Get(req.Provider)
	if !ok {
		respondNotFound(w, fmt.Sprintf("Provider %q not found", req.Provider))
		return
	}

	if p.Type == provider.TypeGitHub {
		client := github.NewClientWithContext(r.Context(), p.Token, p.Username)
		results, err := client.Search(nil, req.Query, 20)
		if err != nil {
			respondInternalError(w, err)
			return
		}

		mapped := make([]repoSearchResult, 0, len(results))
		for _, result := range results {
			mapped = append(mapped, repoSearchResult{
				Name:          result.Name,
				FullPath:      result.FullPath,
				URL:           result.HTTPURL,
				DefaultBranch: result.DefaultBranch,
			})
		}

		respondJSON(w, mapped, http.StatusOK)
		return
	}

	if p.Type == provider.TypeGitLab {
		host := req.Host
		if host == "" {
			for _, appCfg := range s.apps {
				if appCfg.RepositoryPath == "" {
					continue
				}
				if appCfg.Provider == p.Name || s.resolveSourceTypeForApp(appCfg) == provider.TypeGitLab {
					host = extractHostFromURL(appCfg.RepositoryPath)
					if host != "" {
						break
					}
				}
			}
		}

		if host == "" {
			respondBadRequest(w, "GitLab host is required for search. Provide 'host' parameter or add an app with this provider first.")
			return
		}

		client := gitlab.NewClientWithContext(r.Context(), "https://"+host, p.Token, p.Username)
		results, err := client.SearchProjects(req.Query, 20)
		if err != nil {
			respondInternalError(w, err)
			return
		}

		mapped := make([]repoSearchResult, 0, len(results))
		for _, result := range results {
			mapped = append(mapped, repoSearchResult{
				Name:          result.Name,
				FullPath:      result.FullPath,
				URL:           result.HTTPURL,
				DefaultBranch: result.DefaultBranch,
			})
		}

		respondJSON(w, mapped, http.StatusOK)
		return
	}

	respondBadRequest(w, fmt.Sprintf("Unsupported provider type: %s", p.Type))
}

// handleRepoBranches returns all branches for a repository URL.
func (s *Server) handleRepoBranches(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	repoURL := r.URL.Query().Get("url")
	providerName := r.URL.Query().Get("provider")
	_ = providerName

	if strings.TrimSpace(repoURL) == "" {
		respondBadRequest(w, "url parameter is required")
		return
	}

	branches, err := s.services.GitRepository().GetBranches(repoURL)
	if err != nil {
		respondInternalError(w, err)
		return
	}

	respondJSON(w, map[string]interface{}{"branches": branches}, http.StatusOK)
}

// handleCreateApp creates a new application entry in split definition files.
func (s *Server) handleCreateApp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	if s.services.AppManager() == nil {
		respondInternalError(w, fmt.Errorf("app manager not initialized"))
		return
	}
	if s.services.ProviderStore() == nil {
		respondInternalError(w, fmt.Errorf("provider store not initialized"))
		return
	}

	var req struct {
		DisplayName        string `json:"displayName"`
		RepositoryURL      string `json:"repositoryURL"`
		Branch             string `json:"branch"`
		Provider           string `json:"provider"`
		DefinitionLocation string `json:"definitionLocation"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, fmt.Sprintf("Invalid request body: %v", err))
		return
	}

	req.DisplayName = strings.TrimSpace(req.DisplayName)
	req.RepositoryURL = strings.TrimSpace(req.RepositoryURL)
	req.Branch = strings.TrimSpace(req.Branch)
	req.Provider = strings.TrimSpace(req.Provider)

	if req.DisplayName == "" || req.RepositoryURL == "" || req.Branch == "" || req.Provider == "" {
		respondBadRequest(w, "displayName, repositoryURL, branch and provider are required")
		return
	}

	p, ok := s.services.ProviderStore().Get(req.Provider)
	if !ok {
		respondNotFound(w, fmt.Sprintf("Provider %q not found", req.Provider))
		return
	}

	appType := app.TypeAPP
	if req.DefinitionLocation == "libraries" {
		appType = app.TypeLIB
	}

	ident := slugify(req.DisplayName)
	if ident == "" {
		respondBadRequest(w, "displayName must contain at least one alphanumeric character")
		return
	}

	newApp := app.App{
		Ident:              ident,
		DisplayName:        req.DisplayName,
		RepositoryPath:     req.RepositoryURL,
		Branch:             req.Branch,
		AppType:            appType,
		Provider:           req.Provider,
		MainWorktreeBranch: req.Branch,
		ActiveWorktree:     req.Branch,
	}

	if err := s.services.AppManager().AddApp(newApp); err != nil {
		respondErrorMessage(w, err.Error(), http.StatusConflict)
		return
	}

	// Seed the initial MainWorktreeBranch into SQLite BEFORE reloadAppConfig so
	// that when LoadConfig runs resolveActiveWorktreePath it finds a matching
	// mainWorktreeBranch and routes to the primary worktree directory (not a
	// non-existent linked worktree path).  The async clone may later overwrite
	// this with the actual branch when the remote redirects to a different default.
	if req.Branch != "" {
		if setErr := s.services.AppManager().SetMainWorktreeBranch(ident, req.Branch); setErr != nil {
			log.Printf("[WARN] devenv: failed to seed MainWorktreeBranch for new app %s: %v", ident, setErr)
		}
	}

	s.reloadAppConfig()

	if targetApp := s.findAppByIdent(ident); targetApp != nil {
		appCopy := *targetApp
		s.updateOrCreateRepoWithStatus(&appCopy, nil)
	}

	s.BroadcastEvent(Event{
		Type:       "apps.updated",
		Properties: map[string]interface{}{"action": "created", "ident": ident},
		Timestamp:  time.Now(),
	})

	responseApp := newApp
	responseApp.SourceType = p.Type
	respondJSON(w, responseApp, http.StatusCreated)
}

func (s *Server) resolveSourceTypeForApp(a app.App) string {
	if a.Provider != "" && s.services != nil && s.services.ProviderStore() != nil {
		if p, ok := s.services.ProviderStore().Get(a.Provider); ok {
			if p.Type != "" {
				return p.Type
			}
		}
	}

	if a.SourceType != "" {
		return a.SourceType
	}

	repo := strings.ToLower(a.RepositoryPath)
	if strings.Contains(repo, "github.com") {
		return provider.TypeGitHub
	}

	return ""
}

// handleDeleteApp removes an application from split definition files.
func (s *Server) handleDeleteApp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		respondMethodNotAllowed(w)
		return
	}

	if s.services.AppManager() == nil {
		respondErrorMessage(w, "App manager not initialized", http.StatusServiceUnavailable)
		return
	}

	ident := r.PathValue("ident")
	if ident == "" {
		respondBadRequest(w, "Missing app identifier")
		return
	}

	if err := s.services.AppManager().RemoveApp(ident, true); err != nil {
		respondErrorMessage(w, err.Error(), http.StatusNotFound)
		return
	}

	s.reloadAppConfig()

	s.BroadcastEvent(Event{
		Type:       "apps.updated",
		Properties: map[string]interface{}{"action": "deleted", "ident": ident},
		Timestamp:  time.Now(),
	})

	respondSuccess(w, nil, "App removed successfully")
}
