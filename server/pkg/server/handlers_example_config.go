package server

import (
	"log"
	"net/http"

	"github.com/friendsfriend/devenv/pkg/exampleconfig"
)

func (s *Server) handleCreateExampleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	generator := exampleconfig.Generator{
		ConfigDir: s.services.ResourcesManager().ConfigDir(),
		HomeDir:   s.services.HomeDir(),
	}
	if err := generator.Generate(); err != nil {
		respondJSON(w, map[string]string{"error": err.Error()}, http.StatusConflict)
		return
	}

	if err := s.services.AppManager().LoadConfig(); err != nil {
		log.Printf("[WARN] Failed to reload app config after example generation: %v", err)
		respondInternalError(w, err)
		return
	}
	s.apps = s.services.AppManager().GetApps()
	s.infraServices = s.services.AppManager().GetInfraServices()

	respondJSON(w, map[string]bool{"ok": true}, http.StatusOK)
}
