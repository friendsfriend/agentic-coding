package actionregistry

import "testing"

func TestCompileGitActionsExplicitCommandSteps(t *testing.T) {
	actions := CompileGitActions("api", "/repo")
	if len(actions) != 8 {
		t.Fatalf("actions=%d", len(actions))
	}
	pull := actions[0]
	if pull.ActionID != "app/api/action/pull/git/default" {
		t.Fatalf("id=%s", pull.ActionID)
	}
	want := []string{"Get ref", "Fetch", "Pull"}
	if len(pull.RootStep.ChildSteps) != len(want) {
		t.Fatalf("steps=%#v", pull.RootStep.ChildSteps)
	}
	for i, label := range want {
		step := pull.RootStep.ChildSteps[i]
		if step.DisplayLabel != label || step.StepType != "command" || step.Configuration["command"] != "git" {
			t.Fatalf("step %d=%#v", i, step)
		}
	}
}
func TestCompileGitActionsUnavailableWithoutCheckout(t *testing.T) {
	for _, action := range CompileGitActions("api", "") {
		if action.AvailabilityState.Available || action.AvailabilityState.Reason != "checkout required" {
			t.Fatalf("availability=%#v", action.AvailabilityState)
		}
	}
}
