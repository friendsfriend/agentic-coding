package actionexec

import (
	"github.com/friendsfriend/devenv/pkg/actiondef"
	"github.com/friendsfriend/devenv/pkg/actionrun"
	"testing"
)

func TestActionRunProjectionStoresDefinitionIdentityOutcomeAndReferences(t *testing.T) {
	registry := actionrun.NewRegistry()
	if err := registry.Start(actionrun.Run{ID: "run", Status: actionrun.StatusActive, Steps: []actionrun.Step{}}, "api", "run", nil); err != nil {
		t.Fatal(err)
	}
	projection := ActionRunProjection{Registry: registry}
	projection.Emit(Event{Type: "step.started", RunID: "run", StepID: "canonical", Label: "Start db"})
	projection.Emit(Event{Type: "step.completed", RunID: "run", StepID: "canonical", Outcome: actiondef.OutcomeAlreadyRunning})
	projection.Emit(Event{Type: "step.reference", RunID: "run", StepID: "reference", CanonicalID: "canonical", Reference: true})
	run, _ := registry.Get("run")
	if len(run.Steps) != 2 || run.Steps[0].Outcome != actiondef.OutcomeAlreadyRunning || !run.Steps[1].SharedReference || run.Steps[1].CanonicalID != "canonical" {
		t.Fatalf("steps=%#v", run.Steps)
	}
}
