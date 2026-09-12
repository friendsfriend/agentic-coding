package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/friendsfriend/devenv/pkg/status"
)

// handleDockerStart starts a Docker container by containerID
func (s *Server) handleDockerStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	containerID := r.URL.Query().Get("containerID")
	appIdent := r.URL.Query().Get("appIdent")

	if containerID == "" {
		respondBadRequest(w, "containerID parameter required")
		return
	}

	log.Printf("[INFO] Starting container: %s (app: %s)", containerID, appIdent)

	var statusCallback func(string)
	if appIdent != "" && s.services.StatusManager() != nil {
		statusCallback = s.services.StatusManager().StartOperation(appIdent, status.OpStart)
	}

	err := s.runDockerContainerAction(appIdent, containerID, "start", func() error {
		return s.services.DockerClient().StartContainer(containerID)
	})
	if err != nil {
		log.Printf("[ERROR] Failed to start container %s: %v", containerID, err)
		if statusCallback != nil {
			statusCallback(fmt.Sprintf("Error: %v", err))
		}
		respondErrorMessage(w, fmt.Sprintf("Failed to start container: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[INFO] Successfully started container: %s", containerID)
	if appIdent != "" && s.services.BuildService() != nil {
		s.services.BuildService().SetLastRunRuntime(appIdent, "docker")
	}

	// Update transient operation status
	if statusCallback != nil {
		statusCallback("start successful")
	}

	// Broadcast Docker event
	s.BroadcastEvent(Event{
		Type: "docker.container.started",
		Properties: map[string]interface{}{
			"containerID": containerID,
			"appIdent":    appIdent,
		},
		Timestamp: time.Now(),
	})

	// Retry broadcast until Docker status actually changes (up to 15s, polling every 500ms)
	if appIdent != "" {
		prevStatus := s.getDockerStatus(appIdent)
		s.broadcastAppStatusWithRetry(appIdent, prevStatus)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":     true,
		"containerID": containerID,
		"action":      "started",
	})
}

// handleDockerStop stops a Docker container by containerID
func (s *Server) handleDockerStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	containerID := r.URL.Query().Get("containerID")
	appIdent := r.URL.Query().Get("appIdent")

	if containerID == "" {
		respondBadRequest(w, "containerID parameter required")
		return
	}

	log.Printf("[INFO] Stopping container: %s (app: %s)", containerID, appIdent)

	var statusCallback func(string)
	if appIdent != "" && s.services.StatusManager() != nil {
		statusCallback = s.services.StatusManager().StartOperation(appIdent, status.OpStop)
	}

	err := s.runDockerContainerAction(appIdent, containerID, "stop", func() error {
		return s.services.DockerClient().StopContainer(containerID)
	})
	if err != nil {
		log.Printf("[ERROR] Failed to stop container %s: %v", containerID, err)
		if statusCallback != nil {
			statusCallback(fmt.Sprintf("Error: %v", err))
		}
		respondErrorMessage(w, fmt.Sprintf("Failed to stop container: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[INFO] Successfully stopped container: %s", containerID)

	// Update transient operation status
	if statusCallback != nil {
		statusCallback("stop successful")
	}

	// Broadcast Docker event
	s.BroadcastEvent(Event{
		Type: "docker.container.stopped",
		Properties: map[string]interface{}{
			"containerID": containerID,
			"appIdent":    appIdent,
		},
		Timestamp: time.Now(),
	})

	// Retry broadcast until Docker status actually changes (up to 15s, polling every 500ms)
	if appIdent != "" {
		prevStatus := s.getDockerStatus(appIdent)
		s.broadcastAppStatusWithRetry(appIdent, prevStatus)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":     true,
		"containerID": containerID,
		"action":      "stopped",
	})
}

// handleDockerRestart restarts a Docker container by containerID
func (s *Server) handleDockerRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondMethodNotAllowed(w)
		return
	}

	containerID := r.URL.Query().Get("containerID")
	appIdent := r.URL.Query().Get("appIdent")

	if containerID == "" {
		respondBadRequest(w, "containerID parameter required")
		return
	}

	log.Printf("[INFO] Restarting container: %s (app: %s)", containerID, appIdent)

	var statusCallback func(string)
	if appIdent != "" && s.services.StatusManager() != nil {
		statusCallback = s.services.StatusManager().StartOperation(appIdent, status.OpStop)
	}

	err := s.runDockerContainerAction(appIdent, containerID, "restart", func() error {
		return s.services.DockerClient().RestartContainer(containerID)
	})
	if err != nil {
		log.Printf("[ERROR] Failed to restart container %s: %v", containerID, err)
		if statusCallback != nil {
			statusCallback(fmt.Sprintf("Error: %v", err))
		}
		respondErrorMessage(w, fmt.Sprintf("Failed to restart container: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[INFO] Successfully restarted container: %s", containerID)
	if appIdent != "" && s.services.BuildService() != nil {
		s.services.BuildService().SetLastRunRuntime(appIdent, "docker")
	}

	// Update transient operation status
	if statusCallback != nil {
		statusCallback("restart successful")
	}

	// Broadcast Docker event
	s.BroadcastEvent(Event{
		Type: "docker.container.restarted",
		Properties: map[string]interface{}{
			"containerID": containerID,
			"appIdent":    appIdent,
		},
		Timestamp: time.Now(),
	})

	// Retry broadcast until Docker status actually changes (up to 15s, polling every 500ms)
	if appIdent != "" {
		prevStatus := s.getDockerStatus(appIdent)
		s.broadcastAppStatusWithRetry(appIdent, prevStatus)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":     true,
		"containerID": containerID,
		"action":      "restarted",
	})
}

// handleDockerLogs retrieves logs from a Docker container
func (s *Server) handleDockerLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	containerID := r.URL.Query().Get("containerID")
	if containerID == "" {
		respondBadRequest(w, "containerID parameter required")
		return
	}

	debugLog("Fetching logs for container: %s", containerID)

	logs, err := s.services.DockerClient().GetContainerLogs(containerID)
	if err != nil {
		log.Printf("[ERROR] Failed to fetch container logs: %v", err)
		respondErrorMessage(w, fmt.Sprintf("Failed to fetch container logs: %v", err), http.StatusInternalServerError)
		return
	}

	debugLog("Successfully fetched %d bytes of logs", len(logs))

	// Return logs as plain text
	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(logs))
}

// handleDockerStatsStream streams real-time container stats via SSE.
// GET /api/docker/stats/stream?containerID=<id>
func (s *Server) handleDockerStatsStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	containerID := r.URL.Query().Get("containerID")
	if containerID == "" {
		respondBadRequest(w, "containerID parameter required")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	statsCh, err := s.services.DockerClient().StreamContainerStats(r.Context(), containerID)
	if err != nil {
		log.Printf("[ERROR] Failed to start stats stream for container %s: %v", containerID, err)
		data, _ := json.Marshal(map[string]string{"error": fmt.Sprintf("Failed to stream stats: %v", err)})
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
		return
	}

	debugLog("Streaming stats for container: %s", containerID)

	for entry := range statsCh {
		data, err := json.Marshal(entry)
		if err != nil {
			log.Printf("[ERROR] Failed to marshal stats entry: %v", err)
			continue
		}
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}

	debugLog("Stats stream ended for container: %s", containerID)
}

func (s *Server) handleDockerLogsStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondMethodNotAllowed(w)
		return
	}

	containerID := r.URL.Query().Get("containerID")
	if containerID == "" {
		respondBadRequest(w, "containerID parameter required")
		return
	}

	tail := r.URL.Query().Get("tail")
	if tail == "" {
		tail = "100"
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	lineCh, err := s.services.DockerClient().StreamContainerLogs(r.Context(), containerID, tail)
	if err != nil {
		log.Printf("[ERROR] Failed to start log stream for container %s: %v", containerID, err)
		data, _ := json.Marshal(map[string]string{"error": fmt.Sprintf("Failed to stream logs: %v", err)})
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
		return
	}

	debugLog("Streaming logs for container: %s", containerID)

	for line := range lineCh {
		data, err := json.Marshal(map[string]string{"line": line})
		if err != nil {
			continue
		}
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}

	debugLog("Log stream ended for container: %s", containerID)
}
