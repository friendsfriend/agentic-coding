package server

import (
	"time"

	"github.com/friendsfriend/devenv/pkg/actionrun"
)

func (s *Server) runScriptAction(ident, title, command string, fn func() (error, string, string)) (error, string) {
	stepID := ident + ":command-step-0"
	commandID := stepID + "-command-0"
	step := actionrun.Step{ID: stepID, Label: title, Status: actionrun.StatusPending, Commands: []actionrun.Command{}}
	runID, err := s.beginActionPlan(title, ident, "task.run", "", "", []actionrun.Step{step})
	if err != nil {
		return err, ""
	}
	s.BroadcastEvent(Event{Type: "action.step.started", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "label": title}, Timestamp: time.Now()})
	s.BroadcastEvent(Event{Type: "action.command.started", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "commandId": commandID, "command": command, "index": 0}, Timestamp: time.Now()})
	runErr, stdout, stderr := fn()
	if stdout != "" {
		s.emitActionOutput(runID, stepID, commandID, command, stdout, "stdout")
	}
	if stderr != "" {
		s.emitActionOutput(runID, stepID, commandID, command, stderr, "stderr")
	}
	status := actionrun.StatusCompleted
	props := map[string]interface{}{"runId": runID, "stepId": stepID, "commandId": commandID, "exitCode": commandExitCode(runErr)}
	if runErr != nil {
		status, props["error"] = actionrun.StatusFailed, runErr.Error()
		s.BroadcastEvent(Event{Type: "action.command.failed", Properties: props, Timestamp: time.Now()})
		s.BroadcastEvent(Event{Type: "action.step.failed", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "error": runErr.Error()}, Timestamp: time.Now()})
	} else {
		s.BroadcastEvent(Event{Type: "action.command.completed", Properties: props, Timestamp: time.Now()})
		s.BroadcastEvent(Event{Type: "action.step.completed", Properties: map[string]interface{}{"runId": runID, "stepId": stepID}, Timestamp: time.Now()})
	}
	s.finishAction(runID, status)
	s.BroadcastEvent(Event{Type: "action.completed", Properties: map[string]interface{}{"runId": runID, "status": status}, Timestamp: time.Now()})
	return runErr, stdout + stderr
}
