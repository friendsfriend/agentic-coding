package server

import (
	"fmt"
	"net/http"
	"os"

	"github.com/friendsfriend/devenv/pkg/app"
)

func (s *Server) handleInfraServiceLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}
	ident := r.PathValue("ident")
	svc := s.findInfraServiceByIdent(ident)
	if svc == nil || (svc.Type != app.InfraServiceTypeScript) {
		respondNotFound(w, "Script infrastructure service not found")
		return
	}
	_, logPath := s.services.OperationsService().ScriptInfrastructureStatus(ident)
	if logPath == "" {
		logPath = svc.LogPath
	}
	if logPath == "" {
		respondErrorMessage(w, "No script log path available", http.StatusNotFound)
		return
	}
	content, err := os.ReadFile(logPath)
	if err != nil {
		respondErrorMessage(w, fmt.Sprintf("Failed to read script log: %v", err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(content)
}
