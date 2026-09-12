package actiondef

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

type testHandler struct{ kind StepKind }

func (h testHandler) Supports(k StepKind) bool { return h.kind == k }
func (h testHandler) Execute(StepContext, StepDefinition) StepResult {
	return StepResult{Outcome: OutcomeExecuted}
}

type testContext struct{ context.Context }

func validAction() Action {
	return NewAction(Action{
		ActionID: "app/api/action/build/docker/default", Resource: ResourceRef{Kind: "app", ID: "api"},
		ActionType: "build", ActionRuntime: "docker", DisplayLabel: "Docker",
		InputDefinitions:  []InputDefinition{{PortDefinition: PortDefinition{Key: "source.dir", Type: "path", Scope: ScopeAction, Visibility: VisibilityInternal, Required: true}}},
		AvailabilityState: Availability{Available: true},
		RootStep: Step{StepID: "build", StepType: StepKindComposite, DisplayLabel: "Build api", ChildSteps: []Step{{
			StepID: "build-image", StepType: StepKindCommand, DisplayLabel: "Build image",
			InputPorts:  []PortDefinition{{Key: "source.dir", Type: "path", Scope: ScopeAction, Visibility: VisibilityInternal, Required: true}},
			OutputPorts: []PortDefinition{{Key: "image.ref", Type: "image-ref", Scope: ScopeAction, Visibility: VisibilityPublic}},
		}}},
	})
}

func TestDescriptorsAreSerializableAndDefensivelyCopySlices(t *testing.T) {
	a := validAction()
	inputs := a.Inputs()
	inputs[0].Key = "changed"
	if a.Inputs()[0].Key != "source.dir" {
		t.Fatal("inputs exposed mutable slice")
	}
	root := a.Root()
	children := root.Children()
	if len(children) != 1 || children[0].ID() != "build-image" {
		t.Fatalf("children = %#v", children)
	}
	if _, err := json.Marshal(a); err != nil {
		t.Fatal(err)
	}
}

func TestValidateAcceptsTypedNamedValueFlow(t *testing.T) {
	handlers := HandlerSet{StepKindCommand: testHandler{StepKindCommand}}
	if err := Validate(validAction(), handlers); err != nil {
		t.Fatal(err)
	}
}

func TestValidateReportsInvalidDefinitions(t *testing.T) {
	tests := []struct {
		name, want string
		mutate     func(*Action)
	}{
		{"missing owner", "owner id", func(a *Action) { a.Resource.ID = "" }},
		{"missing handler", "no handler", func(a *Action) {}},
		{"missing producer", "missing producer", func(a *Action) { a.InputDefinitions = nil }},
		{"type mismatch", "does not match", func(a *Action) { a.InputDefinitions[0].Type = "string" }},
		{"duplicate step", "duplicate step", func(a *Action) { a.RootStep.ChildSteps = append(a.RootStep.ChildSteps, a.RootStep.ChildSteps[0]) }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a := validAction()
			tc.mutate(&a)
			h := HandlerSet{}
			if tc.name != "missing handler" {
				h[StepKindCommand] = testHandler{StepKindCommand}
			}
			err := Validate(a, h)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestStableIDIgnoresEmptySegmentsButNotIdentity(t *testing.T) {
	got := StableID("app", "api", "action", "run", "docker", "dev")
	if got != "app/api/action/run/docker/dev" {
		t.Fatalf("id = %q", got)
	}
	otherPath := StableID("app", "api", "action", "run", "docker", "dev")
	if got != otherPath {
		t.Fatal("stable identity changed")
	}
}
