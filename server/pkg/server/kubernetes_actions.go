package server

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/actionrun"
	k8s "github.com/friendsfriend/devenv/pkg/kubernetes"
)

func kubernetesClusterStepID(index int) string {
	return fmt.Sprintf("kubernetes:cluster:step-%d", index)
}

func (s *Server) runKubernetesClusterAction(ctx context.Context, title, action string, fn func(k8s.ClusterService) error) error {
	runID, err := s.beginActionPlan(title, "kubernetes", "cluster."+action, "", "", []actionrun.Step{})
	if err != nil {
		return err
	}
	commandIndex := 0
	observer := func(observation k8s.CommandObservation) {
		index := commandIndex
		stepID := kubernetesClusterStepID(index)
		commandID := stepID + "-command-0"
		commandIndex++
		command := strings.TrimSpace(strings.Join(append([]string{observation.Command.Name}, observation.Command.Args...), " "))
		kind := actionrun.KubernetesClusterCommandStepKind(strings.Join(observation.Command.Args, " "))
		label := actionrun.StepLabel(string(kind), command)
		step := actionrun.Step{ID: stepID, Label: label, Status: actionrun.StatusPending, Commands: []actionrun.Command{}}
		s.actionRuns.AddStep(runID, step)
		s.BroadcastEvent(Event{Type: "action.step.started", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "label": label, "command": command, "index": index}, Timestamp: time.Now()})
		s.BroadcastEvent(Event{Type: "action.command.started", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "commandId": commandID, "command": command, "index": 0}, Timestamp: time.Now()})
		if observation.Output != "" {
			s.BroadcastEvent(Event{Type: "action.step.output", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "commandId": commandID, "command": command, "output": observation.Output, "stream": "stdout"}, Timestamp: time.Now()})
		}
		if observation.Stderr != "" {
			s.BroadcastEvent(Event{Type: "action.step.output", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "commandId": commandID, "command": command, "output": observation.Stderr, "stream": "stderr"}, Timestamp: time.Now()})
		}
		props := map[string]interface{}{"runId": runID, "stepId": stepID, "commandId": commandID}
		if observation.Err != nil {
			props["error"] = observation.Err.Error()
			props["exitCode"] = commandExitCode(observation.Err)
			s.BroadcastEvent(Event{Type: "action.command.failed", Properties: props, Timestamp: time.Now()})
			s.BroadcastEvent(Event{Type: "action.step.failed", Properties: map[string]interface{}{"runId": runID, "stepId": stepID, "error": observation.Err.Error()}, Timestamp: time.Now()})
		} else {
			props["exitCode"] = 0
			s.BroadcastEvent(Event{Type: "action.command.completed", Properties: props, Timestamp: time.Now()})
			s.BroadcastEvent(Event{Type: "action.step.completed", Properties: map[string]interface{}{"runId": runID, "stepId": stepID}, Timestamp: time.Now()})
		}
	}
	service := s.kubernetesClusterService()
	service.Observe = observer
	err = fn(service)
	status := actionrun.StatusCompleted
	if err != nil {
		status = actionrun.StatusFailed
	}
	s.finishAction(runID, status)
	s.BroadcastEvent(Event{Type: "action.completed", Properties: map[string]interface{}{"runId": runID, "status": status}, Timestamp: time.Now()})
	return err
}

func commandExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return 1
}
