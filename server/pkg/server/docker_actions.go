package server

import (
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/actionrun"
)

// Docker client lifecycle calls use the Docker API rather than executing a process command.
// Keep them as commandless actions instead of fabricating a shell command or exit code.
func (s *Server) runDockerContainerAction(appIdent, containerID, operation string, fn func() error) error {
	title := strings.ToUpper(operation[:1]) + operation[1:] + " container " + containerID
	runID, err := s.beginActionPlan(title, appIdent, "docker.container."+operation, "", containerID, []actionrun.Step{})
	if err != nil {
		return err
	}
	err = fn()
	status := actionrun.StatusCompleted
	props := map[string]interface{}{"runId": runID, "status": status}
	if err != nil {
		status, props["status"], props["error"] = actionrun.StatusFailed, actionrun.StatusFailed, err.Error()
	}
	s.finishAction(runID, status)
	s.BroadcastEvent(Event{Type: "action.completed", Properties: props, Timestamp: time.Now()})
	return err
}
