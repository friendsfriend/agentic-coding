package actionexec

import (
	"time"

	"github.com/friendsfriend/devenv/pkg/actionrun"
)

// ActionRunProjection keeps migration-compatible action history from engine events.
type ActionRunProjection struct{ Registry *actionrun.Registry }

func (p ActionRunProjection) Emit(event Event) {
	if p.Registry == nil {
		return
	}
	runID := string(event.RunID)
	stepID := string(event.StepID)
	switch event.Type {
	case "step.started":
		now := event.At
		if now.IsZero() {
			now = time.Now()
		}
		p.Registry.AddStep(runID, actionrun.Step{ID: stepID, DefinitionID: event.StepID, Label: event.Label, Status: actionrun.StatusActive, StartedAt: &now, Commands: []actionrun.Command{}})
	case "step.reference":
		p.Registry.AddStep(runID, actionrun.Step{ID: stepID, DefinitionID: event.StepID, Label: event.Label, CanonicalID: event.CanonicalID, SharedReference: true, Status: actionrun.StatusActive, Commands: []actionrun.Command{}})
	case "step.completed":
		p.Registry.UpdateStep(runID, stepID, func(step *actionrun.Step) {
			now := event.At
			if now.IsZero() {
				now = time.Now()
			}
			step.Status = actionrun.StatusCompleted
			step.FinishedAt = &now
			step.Outcome = event.Outcome
		})
	case "step.failed":
		p.Registry.UpdateStep(runID, stepID, func(step *actionrun.Step) {
			now := event.At
			if now.IsZero() {
				now = time.Now()
			}
			step.Status = actionrun.StatusFailed
			step.FinishedAt = &now
			step.Outcome = event.Outcome
			step.Error = event.Error
		})
	}
}
