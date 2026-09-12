package server

import (
	"testing"

	"github.com/friendsfriend/devenv/pkg/actionrun"
)

type fakeStepConfigurator struct {
	stepEvent   func(stepID, kind, status, message string)
	output      func(stepID, stream, chunk string)
	command     func(stepID, command string, args []string)
	commandDone func(stepID string, err error)
}

func (f *fakeStepConfigurator) ConfigureActionOutput(_, _, _ string, output func(string, string, string)) {
	f.output = output
}
func (f *fakeStepConfigurator) ConfigureActionCommand(_ string, command func(string, string, []string)) {
	f.command = command
}
func (f *fakeStepConfigurator) ConfigureActionCommandDone(_ string, done func(string, error)) {
	f.commandDone = done
}
func (f *fakeStepConfigurator) ConfigureActionStepEvent(_ string, event func(string, string, string, string)) {
	f.stepEvent = event
}
func (f *fakeStepConfigurator) SetActionStep(string) {}
func (f *fakeStepConfigurator) ClearActionOutput()   {}

func TestConfigureActionStepEventDoesNotDuplicateOrMislabelPreDeclaredSteps(t *testing.T) {
	s := &Server{actionRuns: actionrun.NewRegistry()}
	preDeclared := actionrun.Step{ID: "app:dep", Label: "Start dependency: db", Status: actionrun.StatusPending, Commands: []actionrun.Command{}}
	runID, err := s.beginActionPlan("Run app", "app", "run", "", "", []actionrun.Step{preDeclared, {ID: "app:root", Label: "Start application: app", Status: actionrun.StatusPending, Commands: []actionrun.Command{}}})
	if err != nil {
		t.Fatal(err)
	}
	configurator := &fakeStepConfigurator{}
	done := make(chan struct{})
	s.runAction("app", runID, "app:root", "", true, configurator, func() {
		// A wrongly-classified kind must not overwrite the pre-declared label
		// or duplicate the step, since it already exists in the run.
		configurator.stepEvent("app:dep", string(actionrun.StepKindKubernetesClusterCreate), "started", "")
		configurator.stepEvent("app:dep", "", "completed", "")
		close(done)
	})
	<-done

	run, ok := s.actionRuns.Get(runID)
	if !ok {
		t.Fatal("run not found")
	}
	count := 0
	for _, step := range run.Steps {
		if step.ID == "app:dep" {
			count++
			if step.Label != "Start dependency: db" {
				t.Fatalf("pre-declared step label overwritten: %q", step.Label)
			}
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one app:dep step, got %d", count)
	}
}

func TestConfigureActionStepEventCreatesNewDynamicStepWithRegistryLabel(t *testing.T) {
	s := &Server{actionRuns: actionrun.NewRegistry()}
	runID, err := s.beginActionPlan("Run app", "app", "run", "", "", []actionrun.Step{{ID: "app:root", Label: "Start application: app", Status: actionrun.StatusPending, Commands: []actionrun.Command{}}})
	if err != nil {
		t.Fatal(err)
	}
	configurator := &fakeStepConfigurator{}
	done := make(chan struct{})
	s.runAction("app", runID, "app:root", "", true, configurator, func() {
		configurator.stepEvent("kubernetes:cluster:app:check", string(actionrun.StepKindKubernetesClusterCheck), "started", "")
		configurator.stepEvent("kubernetes:cluster:app:check", "", "completed", "")
		close(done)
	})
	<-done

	run, ok := s.actionRuns.Get(runID)
	if !ok {
		t.Fatal("run not found")
	}
	var found *actionrun.Step
	for i := range run.Steps {
		if run.Steps[i].ID == "kubernetes:cluster:app:check" {
			found = &run.Steps[i]
		}
	}
	if found == nil || found.Label != "Check cluster" {
		t.Fatalf("dynamic step missing or mislabeled: %#v", found)
	}
}

// TestReadinessOutputAfterCommandDoneAttachesToOwningStepNotStaleCommand
// reproduces the reported bug: a dependency step runs one real command (e.g.
// docker compose up -d) that completes successfully, and afterwards emits
// diagnostic readiness output for the same step. That output must attach to
// the dependency's own step as a fresh diagnostic pseudo-command, never to
// the already-completed compose command's step (which would otherwise show
// the readiness failure glued onto a step reporting exit 0).
func TestReadinessOutputAfterCommandDoneAttachesToOwningStepNotStaleCommand(t *testing.T) {
	events := map[string][]map[string]interface{}{}
	s := &Server{actionRuns: actionrun.NewRegistry(), listeners: map[chan Event]bool{}}
	depStepID := "app:dep"
	runID, err := s.beginActionPlan("Run app", "app", "run", "", "", []actionrun.Step{
		{ID: depStepID, Label: "Start dependency: postgres", Status: actionrun.StatusPending, Commands: []actionrun.Command{}},
		{ID: "app:root", Label: "Start application: app", Status: actionrun.StatusPending, Commands: []actionrun.Command{}},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Capture broadcast events via a listener channel instead of overriding
	// BroadcastEvent (kept unexported/simple).
	ch := make(chan Event, 64)
	s.listeners[ch] = true

	configurator := &fakeStepConfigurator{}
	done := make(chan struct{})
	s.runAction("app", runID, "app:root", "", true, configurator, func() {
		configurator.command(depStepID, "podman-compose", []string{"up", "-d"})
		configurator.output(depStepID, "stdout", "0ab885cf7191\n")
		configurator.commandDone(depStepID, nil)
		// Readiness diagnostic fires AFTER the compose command already
		// completed, for the SAME originating step.
		configurator.output(depStepID, "stdout", "readiness example-postgres: inspect error: no such container\n")
		configurator.stepEvent(depStepID, "", "failed", "dependency \"app:dep\" failed readiness")
		close(done)
	})
	<-done

	for len(ch) > 0 {
		ev := <-ch
		props, _ := ev.Properties.(map[string]interface{})
		events[ev.Type] = append(events[ev.Type], props)
	}

	run, ok := s.actionRuns.Get(runID)
	if !ok {
		t.Fatal("run not found")
	}
	var composeChild *actionrun.Step
	for i := range run.Steps {
		if run.Steps[i].ParentID == depStepID {
			composeChild = &run.Steps[i]
		}
	}
	if composeChild == nil {
		t.Fatal("expected dynamic compose command step")
	}
	if composeChild.Label != "Start containers" {
		t.Fatalf("compose command label = %q, want human-readable label", composeChild.Label)
	}

	readinessOutputs := events["action.step.output"]
	found := false
	for _, props := range readinessOutputs {
		if props["stepId"] == depStepID && props["output"] == "readiness example-postgres: inspect error: no such container\n" {
			found = true
			if props["stepId"] == composeChild.ID {
				t.Fatal("readiness output must not attach to the completed compose command's step")
			}
		}
	}
	if !found {
		t.Fatalf("expected readiness output attached to %q, got %#v", depStepID, readinessOutputs)
	}
}

func TestGenericBuildCommandGetsHumanReadableStepLabel(t *testing.T) {
	s := &Server{actionRuns: actionrun.NewRegistry()}
	runID, err := s.beginActionPlan("Build app", "app", "build", "", "", []actionrun.Step{{ID: "app:root", Label: "Build app", Status: actionrun.StatusPending, Commands: []actionrun.Command{}}})
	if err != nil {
		t.Fatal(err)
	}
	configurator := &fakeStepConfigurator{}
	done := make(chan struct{})
	s.runAction("app", runID, "app:root", "build", false, configurator, func() {
		configurator.command("", "sh", []string{"/tmp/build.sh"})
		configurator.commandDone("", nil)
		close(done)
	})
	<-done

	run, ok := s.actionRuns.Get(runID)
	if !ok {
		t.Fatal("run not found")
	}
	for _, step := range run.Steps {
		if step.ParentID == "app:root" {
			if step.Label != "Run build command" {
				t.Fatalf("build command label = %q, want %q", step.Label, "Run build command")
			}
			return
		}
	}
	t.Fatal("expected dynamic build command step")
}
