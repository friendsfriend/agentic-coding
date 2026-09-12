package server

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/friendsfriend/devenv/pkg/actionrun"
	gitpkg "github.com/friendsfriend/devenv/pkg/git"
)

func TestGitPullCommandsUseSeparateSemanticSteps(t *testing.T) {
	want := []string{"Get ref", "Fetch", "Pull"}
	commands := []string{"rev-parse --abbrev-ref HEAD", "fetch --force origin +refs/heads/*:refs/remotes/origin/*", "reset --hard origin/main"}
	for i, command := range commands {
		kind := actionrun.GitCommandStepKind(command)
		if got := actionrun.StepLabel(string(kind), command); got != want[i] {
			t.Fatalf("step %d label = %q, want %q", i, got, want[i])
		}
	}
}

func TestGitPullActionDefinitionAndEventSequenceGolden(t *testing.T) {
	const runID = "git-pull-golden"
	events := make(chan Event, 32)
	s := &Server{
		actionRuns: actionrun.NewRegistry(),
		listeners:  map[chan Event]bool{events: true},
	}
	if err := s.actionRuns.Start(actionrun.Run{ID: runID, Title: "Pull app", Status: actionrun.StatusActive, Steps: []actionrun.Step{}}, "app", "pull", nil); err != nil {
		t.Fatal(err)
	}

	records := []gitpkg.ActionStep{
		{Label: "rev-parse --abbrev-ref HEAD", Command: "git rev-parse --abbrev-ref HEAD", Stdout: "main\n"},
		{Label: "fetch --force origin +refs/heads/*:refs/remotes/origin/*", Command: "git fetch --force origin +refs/heads/*:refs/remotes/origin/*"},
		{Label: "reset --hard origin/main", Command: "git reset --hard origin/main", Stdout: "HEAD is now at abc123 change\n"},
	}
	for index, record := range records {
		s.recordGitActionStep(runID, "app", index, record)
	}

	run, ok := s.actionRuns.Get(runID)
	if !ok {
		t.Fatal("run not found")
	}
	definition := make([]map[string]string, 0, len(run.Steps))
	for _, step := range run.Steps {
		definition = append(definition, map[string]string{"id": step.ID, "label": step.Label})
	}
	gotDefinition, err := json.MarshalIndent(definition, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	const wantDefinition = `[
  {
    "id": "git:app:step-0",
    "label": "Get ref"
  },
  {
    "id": "git:app:step-1",
    "label": "Fetch"
  },
  {
    "id": "git:app:step-2",
    "label": "Pull"
  }
]`
	if string(gotDefinition) != wantDefinition {
		t.Fatalf("definition changed:\n%s", gotDefinition)
	}

	gotEvents := make([]string, 0, len(events))
	for len(events) > 0 {
		gotEvents = append(gotEvents, (<-events).Type)
	}
	wantEvents := []string{
		"action.step.started", "action.command.started", "action.step.output", "action.command.completed", "action.step.completed",
		"action.step.started", "action.command.started", "action.command.completed", "action.step.completed",
		"action.step.started", "action.command.started", "action.step.output", "action.command.completed", "action.step.completed",
	}
	if !reflect.DeepEqual(gotEvents, wantEvents) {
		t.Fatalf("event sequence changed:\n got: %v\nwant: %v", gotEvents, wantEvents)
	}
}

func TestGitCommandsGetReadableStepLabelsFromVerbNotPosition(t *testing.T) {
	kind := actionrun.GitCommandStepKind("switch -c branch")
	if got := actionrun.StepLabel(string(kind), "switch -c branch"); got != "Switch branch" {
		t.Fatalf("label = %q", got)
	}
	if kind := actionrun.GitCommandStepKind("symbolic-ref HEAD"); kind != actionrun.StepKindCommand {
		t.Fatalf("unexpected classification: %v", kind)
	}
	if got := actionrun.StepLabel(string(actionrun.StepKindCommand), "symbolic-ref HEAD"); got != "Symbolic-ref HEAD" {
		t.Fatalf("fallback label = %q", got)
	}
}
