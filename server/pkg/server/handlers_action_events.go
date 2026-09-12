package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// handleReportedActionEvent persists action lifecycle events produced by local TUI operations.
func (s *Server) handleReportedActionEvent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}
	var body struct {
		Type       string                 `json:"type"`
		Properties map[string]interface{} `json:"properties"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		respondBadRequest(w, "Invalid action event")
		return
	}
	if !strings.HasPrefix(body.Type, "action.") || body.Type == "action.history" {
		respondBadRequest(w, "Unsupported action event")
		return
	}
	s.BroadcastEvent(Event{Type: body.Type, Properties: body.Properties, Timestamp: time.Now()})
	w.WriteHeader(http.StatusNoContent)
}
