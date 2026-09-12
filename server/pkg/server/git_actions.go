package server

import (
	"fmt"
	"time"

	"github.com/friendsfriend/devenv/pkg/actionrun"
	gitpkg "github.com/friendsfriend/devenv/pkg/git"
)

func (s *Server) recordGitActionStep(runID, appIdent string, index int, recorded gitpkg.ActionStep) {
	stepID := fmt.Sprintf("git:%s:step-%d", appIdent, index)
	commandID := stepID + "-command-0"
	label := actionrun.StepLabel(string(actionrun.GitCommandStepKind(recorded.Label)), recorded.Label)
	step := actionrun.Step{ID: stepID, Label: label, Status: actionrun.StatusPending, Commands: []actionrun.Command{}}
	s.actionRuns.AddStep(runID, step)
	s.BroadcastEvent(Event{Type: "action.step.started", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "label": label, "command": recorded.Command, "index": index}, Timestamp: time.Now()})
	s.BroadcastEvent(Event{Type: "action.command.started", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "commandId": commandID, "command": recorded.Command, "index": 0}, Timestamp: time.Now()})
	if recorded.Stdout != "" {
		s.emitActionOutput(runID, stepID, commandID, recorded.Command, recorded.Stdout, "stdout")
	}
	if recorded.Stderr != "" {
		s.emitActionOutput(runID, stepID, commandID, recorded.Command, recorded.Stderr, "stderr")
	}
	props := map[string]interface{}{"runId": runID, "stepId": stepID, "commandId": commandID, "exitCode": recorded.ExitCode}
	if recorded.Err != nil {
		props["error"] = recorded.Err.Error()
		s.BroadcastEvent(Event{Type: "action.command.failed", Properties: props, Timestamp: time.Now()})
		s.BroadcastEvent(Event{Type: "action.step.failed", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "error": recorded.Err.Error()}, Timestamp: time.Now()})
	} else {
		s.BroadcastEvent(Event{Type: "action.command.completed", Properties: props, Timestamp: time.Now()})
		s.BroadcastEvent(Event{Type: "action.step.completed", Properties: map[string]interface{}{"runId": runID, "stepId": stepID}, Timestamp: time.Now()})
	}
}

func (s *Server) runGitAction(appIdent, title, action, target string, fn func() error) error {
	runID, err := s.beginActionPlan(title, appIdent, action, "", target, []actionrun.Step{})
	if err != nil {
		return err
	}
	repo := s.services.GitRepository()
	instrumented, ok := repo.(gitpkg.InstrumentedRepository)
	if !ok {
		err = fn()
	} else {
		commandIndex := 0
		instrumented.SetActionRecorder(func(recorded gitpkg.ActionStep) {
			index := commandIndex
			commandIndex++
			s.recordGitActionStep(runID, appIdent, index, recorded)
		})
		err = fn()
		instrumented.SetActionRecorder(nil)
	}
	status := actionrun.StatusCompleted
	if err != nil {
		status = actionrun.StatusFailed
	}
	s.finishAction(runID, status)
	s.BroadcastEvent(Event{Type: "action.completed", Properties: map[string]interface{}{"runId": runID, "status": status}, Timestamp: time.Now()})
	return err
}
