package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/resources"
)

func (s *Server) handleShellActionScript(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		respondMethodNotAllowed(w)
		return
	}

	var req struct {
		Ident   string `json:"ident"`
		Action  string `json:"action"`
		Profile string `json:"profile"`
		Command string `json:"command"`
		Runtime string `json:"runtime"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondBadRequest(w, "Invalid request body")
		return
	}
	if req.Ident == "" || req.Action == "" {
		respondBadRequest(w, "ident and action fields required")
		return
	}
	if s.findAppByIdent(req.Ident) == nil {
		respondNotFound(w, "App not found")
		return
	}
	if req.Runtime == "" {
		req.Runtime = string(resources.ActionRuntimeShell)
	}
	var path string
	var err error
	switch resources.ActionRuntime(req.Runtime) {
	case resources.ActionRuntimeShell:
		path, err = s.services.ResourcesManager().WriteShellActionScript(req.Ident, resources.AppAction(req.Action), req.Profile, req.Command)
	case resources.ActionRuntimePowerShell:
		path, err = s.services.ResourcesManager().WritePowerShellActionScript(req.Ident, resources.AppAction(req.Action), req.Profile, req.Command)
	default:
		respondErrorMessage(w, "unsupported action runtime "+req.Runtime, http.StatusBadRequest)
		return
	}
	if err != nil {
		respondErrorMessage(w, err.Error(), http.StatusBadRequest)
		return
	}
	respondJSON(w, map[string]interface{}{"success": true, "path": path}, http.StatusOK)
}

func (s *Server) handleGetProfiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	ident := r.PathValue("ident")
	if ident == "" {
		respondBadRequest(w, "ident path parameter required")
		return
	}

	var targetApp *app.App
	targetApp = s.findAppByIdent(ident)

	// If not an app, check if it's an infrastructure service — for infra services
	// we don't have profiles, but the UI may request profiles before starting.
	// Return an empty profile list and hasDockerfile=false for infra services
	// so the profile picker won't error out.
	if targetApp == nil {
		if infra := s.findInfraServiceByIdent(ident); infra != nil {
			w.Header().Set("Content-Type", "application/json")
			// Infrastructure services do not have profile variants or repo Dockerfiles,
			// but the TUI expects the `hasDockerfile` flag to control whether the
			// "default (no profile)" option is shown. Return hasDockerfile=true so
			// the picker shows the default option and users can proceed to start the
			// infra service without selecting a profile.
			json.NewEncoder(w).Encode(map[string]interface{}{
				"profiles":      []string{},
				"hasDockerfile": true,
			})
			return
		}
		respondNotFound(w, "App not found")
		return
	}

	profiles, err := s.services.ResourcesManager().DiscoverProfiles(targetApp.Ident, targetApp.LocalDirectoryPath)
	if err != nil {
		respondInternalError(w, err)
		return
	}
	if profiles == nil {
		profiles = []string{}
	}

	_, dfErr := s.services.ResourcesManager().ResolveDockerfileForAction(targetApp.Ident, targetApp.LocalDirectoryPath, resources.ActionBuild)
	hasDockerfile := dfErr == nil

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"profiles":      profiles,
		"hasDockerfile": hasDockerfile,
	})
}

func (s *Server) handleCancelAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}
	var req struct {
		Ident string `json:"ident"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Ident == "" {
		respondBadRequest(w, "ident field required")
		return
	}
	s.services.BuildService().CancelAction(req.Ident)
	for _, run := range s.actionRuns.ActiveForApp(req.Ident) {
		s.actionCancelMu.Lock()
		cancel := s.actionCancels[run.ID]
		s.actionCancelMu.Unlock()
		if cancel != nil {
			cancel()
		}
		s.actionRuns.Cancel(run.ID)
		s.BroadcastEvent(Event{Type: "action.completed", Properties: map[string]interface{}{"runId": run.ID, "status": "canceled"}, Timestamp: time.Now()})
	}
	respondJSON(w, map[string]interface{}{"success": true}, http.StatusOK)
}
