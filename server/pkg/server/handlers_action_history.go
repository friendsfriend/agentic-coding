package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

func (s *Server) handleActionHistory(w http.ResponseWriter, r *http.Request) {
	limit := 50000
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 50000 {
			limit = parsed
		}
	}
	now := time.Now()
	since := now.Add(-10 * time.Minute)
	var before time.Time
	switch r.URL.Query().Get("scope") {
	case "all":
		since = now.Add(-24 * time.Hour)
	case "older":
		since = now.Add(-24 * time.Hour)
		before = now.Add(-10 * time.Minute)
	}
	var stored []string
	var err error
	if before.IsZero() {
		stored, err = s.services.StateStore().GetActionEventsSince(limit, since)
	} else {
		stored, err = s.services.StateStore().GetActionEventsBetween(limit, since, before)
	}
	if err != nil {
		respondErrorMessage(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(compactActionHistory(stored))
}

func (s *Server) handleActionLogs(w http.ResponseWriter, r *http.Request) {
	runID := r.URL.Query().Get("runId")
	if runID == "" {
		respondErrorMessage(w, "runId is required", http.StatusBadRequest)
		return
	}
	stored, err := s.services.StateStore().GetActionLogEvents(runID, r.URL.Query().Get("stepId"), 50000)
	if err != nil {
		respondErrorMessage(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(compactActionHistory(stored))
}

type actionHistoryEvent struct {
	Type       string                     `json:"type"`
	Properties map[string]json.RawMessage `json:"properties"`
	Timestamp  json.RawMessage            `json:"timestamp,omitempty"`
}

type actionOutputKey struct{ runID, stepID, commandID, stream string }

func isActionOutputType(eventType string) bool {
	return eventType == "action.command.output" || eventType == "action.step.output"
}

func isActionOutput(event actionHistoryEvent) bool {
	return isActionOutputType(event.Type)
}

func actionOutput(event actionHistoryEvent) (actionOutputKey, string, bool) {
	if !isActionOutput(event) {
		return actionOutputKey{}, "", false
	}
	read := func(name string) (string, bool) {
		var value string
		raw, ok := event.Properties[name]
		return value, ok && json.Unmarshal(raw, &value) == nil
	}
	runID, ok := read("runId")
	if !ok {
		return actionOutputKey{}, "", false
	}
	stepID, ok := read("stepId")
	if !ok {
		return actionOutputKey{}, "", false
	}
	commandID, ok := read("commandId")
	if !ok {
		return actionOutputKey{}, "", false
	}
	stream, ok := read("stream")
	if !ok {
		return actionOutputKey{}, "", false
	}
	output, ok := read("output")
	return actionOutputKey{runID, stepID, commandID, stream}, output, ok
}

// compactActionHistory joins consecutive output chunks. History consumers still
// receive every command and log byte, without paying one JSON/replay step per chunk.
func compactActionHistory(stored []string) []json.RawMessage {
	result := make([]json.RawMessage, 0, len(stored))
	var pending *actionHistoryEvent
	flush := func() {
		if pending == nil {
			return
		}
		if payload, err := json.Marshal(pending); err == nil {
			result = append(result, payload)
		}
		pending = nil
	}
	for _, payload := range stored {
		if !json.Valid([]byte(payload)) {
			continue
		}
		var event actionHistoryEvent
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			flush()
			result = append(result, json.RawMessage(payload))
			continue
		}
		key, output, isOutput := actionOutput(event)
		if !isOutput {
			flush()
			result = append(result, json.RawMessage(payload))
			continue
		}
		if pending != nil {
			previousKey, previousOutput, previousIsOutput := actionOutput(*pending)
			if previousIsOutput && previousKey == key {
				combined, _ := json.Marshal(previousOutput + output)
				pending.Properties["output"] = combined
				continue
			}
		}
		flush()
		pending = &event
	}
	flush()
	return result
}
