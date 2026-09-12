package server

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/friendsfriend/devenv/pkg/actionrun"
	"github.com/google/uuid"
)

// emitActionStarted publishes structured action metadata.
func (s *Server) reserveAction(appIdent, action string, run actionrun.Run) error {
	return s.actionRuns.Start(run, appIdent, action, nil)
}

func (s *Server) finishAction(runID string, status actionrun.Status) {
	s.actionRuns.Complete(runID, status)
}

func (s *Server) beginAction(title, command, appIdent, action, profile, targetLabel string) (string, string, error) {
	runID, stepID := s.emitActionStarted(title, command, appIdent, action, profile, targetLabel)
	run := actionrun.Run{ID: runID, Title: title, Profile: profile, TargetLabel: targetLabel, Status: actionrun.StatusActive}
	if err := s.actionRuns.Start(run, appIdent, action, nil); err != nil {
		return "", "", err
	}
	return runID, stepID, nil
}

func (s *Server) beginActionPlan(title, appIdent, action, profile, targetLabel string, steps []actionrun.Step) (string, error) {
	runID := s.emitActionPlanStarted(title, steps, appIdent, action, profile, targetLabel)
	run := actionrun.Run{ID: runID, Title: title, Profile: profile, TargetLabel: targetLabel, Status: actionrun.StatusActive, Steps: steps}
	if err := s.actionRuns.Start(run, appIdent, action, nil); err != nil {
		return "", err
	}
	return runID, nil
}

func (s *Server) emitActionPlanStarted(title string, steps []actionrun.Step, metadata ...string) string {
	runID := "action-" + uuid.NewString()
	now := time.Now()
	run := actionrun.Run{ID: runID, Title: title, Status: actionrun.StatusActive, Steps: steps, StartedAt: &now}
	if len(metadata) > 0 {
		run.AppIdent = metadata[0]
	}
	if len(metadata) > 1 {
		run.Action = metadata[1]
		run.Kind = actionrun.ActionKind(metadata[1])
	}
	if len(metadata) > 2 {
		run.Profile = metadata[2]
	}
	if len(metadata) > 3 {
		run.TargetLabel = metadata[3]
	}
	s.BroadcastEvent(Event{Type: "action.started", Properties: map[string]interface{}{"run": run}, Timestamp: time.Now()})
	return runID
}

func (s *Server) emitActionStarted(title, command string, metadata ...string) (string, string) {
	runID := "action-" + uuid.NewString()
	stepID := runID + "-step-0"
	commands := []actionrun.Command{}
	if command != "" {
		commands = append(commands, actionrun.Command{ID: stepID + "-command-0", Command: command, Status: actionrun.StatusPending})
	}
	now := time.Now()
	run := actionrun.Run{ID: runID, Title: title, Status: actionrun.StatusActive, Steps: []actionrun.Step{{ID: stepID, Label: title, Commands: commands, Status: actionrun.StatusPending}}, StartedAt: &now}
	if len(metadata) > 0 {
		run.AppIdent = metadata[0]
	}
	if len(metadata) > 1 {
		run.Action = metadata[1]
		run.Kind = actionrun.ActionKind(metadata[1])
	}
	if len(metadata) > 2 {
		run.Profile = metadata[2]
	}
	if len(metadata) > 3 {
		run.TargetLabel = metadata[3]
	}
	s.BroadcastEvent(Event{Type: "action.started", Properties: map[string]interface{}{"run": run}, Timestamp: time.Now()})
	return runID, stepID
}

type actionOutputConfigurator interface {
	ConfigureActionOutput(appIdent, runID, stepID string, output func(stepID, stream, chunk string))
	ConfigureActionCommand(appIdent string, command func(stepID, command string, args []string))
	ConfigureActionCommandDone(appIdent string, done func(stepID string, err error))
	// ConfigureActionStepEvent's kind is a StepKind (optionally packed via
	// actionrun.EncodeStepKind) resolved through the shared label registry;
	// producers must not invent labels from step IDs or ad hoc parsing.
	ConfigureActionStepEvent(appIdent string, event func(stepID, kind, status, message string))
	SetActionStep(stepID string)
	ClearActionOutput()
}

func (s *Server) runAction(appIdent, runID, stepID, operation string, nestedSteps bool, configurator actionOutputConfigurator, fn func()) {
	eventStepID := func(id string) string {
		if nestedSteps && id != "" {
			return id
		}
		return stepID
	}
	s.BroadcastEvent(Event{Type: "action.step.started", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "command": operation, "index": 0}, Timestamp: time.Now()})
	go func() {
		var commandMu sync.RWMutex
		// commandContexts tracks the current command per originating step
		// (parentStepID), not a single shared "last command" pointer. Output
		// and completion for a step must always resolve to that step's own
		// command, never a different step's most-recently-started command
		// (e.g. a readiness check for step A must not attach to step B's
		// already-completed docker compose command just because it ran last).
		type commandContext struct{ id, stepID, text string }
		commandContexts := map[string]*commandContext{}
		commandIndex := 0
		failedStepID := ""
		if configurator != nil {
			configurator.ConfigureActionOutput(appIdent, runID, stepID, func(sourceStepID, stream, chunk string) {
				parentStepID := eventStepID(sourceStepID)
				commandMu.Lock()
				ctx, ok := commandContexts[parentStepID]
				if !ok {
					ctx = &commandContext{id: parentStepID + "-diagnostic", stepID: parentStepID, text: "readiness / container logs"}
					commandContexts[parentStepID] = ctx
				}
				id, outputStepID, text := ctx.id, ctx.stepID, ctx.text
				commandMu.Unlock()
				s.emitActionOutput(runID, outputStepID, id, text, chunk, stream)
			})
			configurator.ConfigureActionCommand(appIdent, func(sourceStepID, command string, args []string) {
				parentStepID := eventStepID(sourceStepID)
				commandMu.Lock()
				index := commandIndex
				commandIndex++
				dynamicStepID := fmt.Sprintf("%s:command-step-%d", parentStepID, index)
				id := dynamicStepID + "-command-0"
				text := strings.TrimSpace(strings.Join(append([]string{command}, args...), " "))
				label := actionrun.StepLabel(string(actionrun.CommandStepKind(operation, command, args)), text)
				commandContexts[parentStepID] = &commandContext{id: id, stepID: dynamicStepID, text: text}
				commandMu.Unlock()
				dynamicStep := actionrun.Step{ID: dynamicStepID, ParentID: parentStepID, Label: label, Status: actionrun.StatusPending, Commands: []actionrun.Command{}}
				s.actionRuns.AddStep(runID, dynamicStep)
				s.BroadcastEvent(Event{Type: "action.step.started", Properties: map[string]interface{}{"runId": runID, "stepId": dynamicStepID, "parentId": parentStepID, "label": label, "index": index}, Timestamp: time.Now()})
				s.BroadcastEvent(Event{Type: "action.command.started", Properties: map[string]interface{}{"runId": runID, "stepId": dynamicStepID, "commandId": id, "command": text, "index": 0}, Timestamp: time.Now()})
			})
			configurator.ConfigureActionStepEvent(appIdent, func(sourceStepID, kind, status, message string) {
				eventStepID := eventStepID(sourceStepID)
				typeName := "action.step." + status
				props := map[string]interface{}{"runId": runID, "stepId": eventStepID}
				if status == "started" && eventStepID != stepID && !s.actionRuns.HasStep(runID, eventStepID) {
					label := actionrun.StepLabel(kind, eventStepID)
					dynamicStep := actionrun.Step{ID: eventStepID, ParentID: stepID, Label: label, Status: actionrun.StatusPending, Commands: []actionrun.Command{}}
					s.actionRuns.AddStep(runID, dynamicStep)
					props["parentId"], props["label"] = stepID, label
				}
				if message != "" {
					props["error"] = message
				}
				if status == "failed" {
					commandMu.Lock()
					failedStepID = eventStepID
					// A step that fails while it still has an unresolved command
					// context (e.g. a readiness poll running after its own
					// docker compose command already completed) must not leave
					// that context lingering for a later, unrelated step to
					// reuse; the client also fails the step's active command.
					delete(commandContexts, eventStepID)
					commandMu.Unlock()
				}
				s.BroadcastEvent(Event{Type: typeName, Properties: props, Timestamp: time.Now()})
			})
			configurator.ConfigureActionCommandDone(appIdent, func(sourceStepID string, err error) {
				parentStepID := eventStepID(sourceStepID)
				commandMu.Lock()
				ctx, ok := commandContexts[parentStepID]
				delete(commandContexts, parentStepID)
				commandMu.Unlock()
				if !ok {
					return
				}
				id, completedStepID := ctx.id, ctx.stepID
				typeName := "action.command.completed"
				props := map[string]interface{}{"runId": runID, "stepId": completedStepID, "commandId": id, "exitCode": 0}
				stepType := "action.step.completed"
				stepProps := map[string]interface{}{"runId": runID, "stepId": completedStepID}
				if err != nil {
					typeName, props["error"] = "action.command.failed", err.Error()
					props["exitCode"] = commandExitCode(err)
					stepType, stepProps["error"] = "action.step.failed", err.Error()
					commandMu.Lock()
					failedStepID = completedStepID
					commandMu.Unlock()
				}
				s.BroadcastEvent(Event{Type: typeName, Properties: props, Timestamp: time.Now()})
				s.BroadcastEvent(Event{Type: stepType, Properties: stepProps, Timestamp: time.Now()})
			})
		}
		status := actionrun.StatusCompleted
		defer func() {
			commandMu.RLock()
			commandFailedStep := failedStepID
			commandMu.RUnlock()
			if commandFailedStep != "" {
				status = actionrun.StatusFailed
				s.BroadcastEvent(Event{Type: "action.step.failed", Properties: map[string]interface{}{"runId": runID, "stepId": commandFailedStep, "error": "command failed"}, Timestamp: time.Now()})
			}
			if recovered := recover(); recovered != nil {
				status = actionrun.StatusFailed
				s.BroadcastEvent(Event{Type: "action.step.failed", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "error": fmt.Sprint(recovered)}, Timestamp: time.Now()})
			} else if commandFailedStep == "" {
				s.BroadcastEvent(Event{Type: "action.step.completed", Properties: map[string]interface{}{"runId": runID, "stepId": stepID}, Timestamp: time.Now()})
			}
			if configurator != nil {
				configurator.ClearActionOutput()
			}
			s.finishAction(runID, status)
			s.BroadcastEvent(Event{Type: "action.completed", Properties: map[string]interface{}{"runId": runID, "status": status}, Timestamp: time.Now()})
		}()
		fn()
	}()
}

func (s *Server) emitActionOutput(runID, stepID, commandID, command, output, stream string) {
	if commandID == "" {
		commandID = stepID + "-diagnostic"
		command = "readiness / container logs"
		s.BroadcastEvent(Event{Type: "action.command.started", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "commandId": commandID, "command": command, "index": 0}, Timestamp: time.Now()})
	}
	props := map[string]interface{}{"runId": runID, "stepId": stepID, "commandId": commandID, "command": command, "output": output, "stream": stream}
	s.BroadcastEvent(Event{Type: "action.step.output", Properties: props, Timestamp: time.Now()})
}
