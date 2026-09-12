package actionexec

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

type handlerFunc struct {
	kind actiondef.StepKind
	fn   func(actiondef.StepContext, actiondef.StepDefinition) actiondef.StepResult
}

func (h handlerFunc) Supports(k actiondef.StepKind) bool { return h.kind == k }
func (h handlerFunc) Execute(c actiondef.StepContext, s actiondef.StepDefinition) actiondef.StepResult {
	return h.fn(c, s)
}

type events struct{ types []string }

func (e *events) Emit(event Event) { e.types = append(e.types, event.Type+":"+string(event.StepID)) }

func action(children ...actiondef.Step) actiondef.Action {
	return actiondef.NewAction(actiondef.Action{ActionID: "action", Resource: actiondef.ResourceRef{Kind: "app", ID: "api"}, RootStep: actiondef.Step{StepID: "root", StepType: actiondef.StepKindComposite, ChildSteps: children}})
}

func TestEngineExecutesSequentialTypedValueFlow(t *testing.T) {
	order := []string{}
	sink := &events{}
	h := handlerFunc{kind: actiondef.StepKindOperation, fn: func(c actiondef.StepContext, s actiondef.StepDefinition) actiondef.StepResult {
		order = append(order, string(s.ID()))
		if s.ID() == "produce" {
			_ = c.Set("image.ref", actiondef.Value{Type: "image-ref", Data: "api:latest"})
		} else if v, err := c.Require("image.ref"); err != nil || v.Data != "api:latest" {
			t.Fatalf("value=%#v err=%v", v, err)
		}
		return actiondef.StepResult{Outcome: actiondef.OutcomeExecuted}
	}}
	engine := Engine{Handlers: HandlerRegistry{actiondef.StepKindOperation: h}, Events: sink}
	result := engine.Run(context.Background(), "run", action(actiondef.Step{StepID: "produce", StepType: actiondef.StepKindOperation}, actiondef.Step{StepID: "consume", StepType: actiondef.StepKindOperation}), nil)
	if result.Err != nil || !reflect.DeepEqual(order, []string{"produce", "consume"}) {
		t.Fatalf("result=%#v order=%v", result, order)
	}
}

func TestEngineStopsNormalStepsAndRunsCleanupAfterFailure(t *testing.T) {
	order := []string{}
	h := handlerFunc{kind: actiondef.StepKindOperation, fn: func(_ actiondef.StepContext, s actiondef.StepDefinition) actiondef.StepResult {
		order = append(order, string(s.ID()))
		if s.ID() == "fail" {
			return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: errors.New("boom")}
		}
		return actiondef.StepResult{Outcome: actiondef.OutcomeExecuted}
	}}
	result := (&Engine{Handlers: HandlerRegistry{actiondef.StepKindOperation: h}}).Run(context.Background(), "run", action(
		actiondef.Step{StepID: "fail", StepType: actiondef.StepKindOperation},
		actiondef.Step{StepID: "skip", StepType: actiondef.StepKindOperation},
		actiondef.Step{StepID: "cleanup", StepType: actiondef.StepKindOperation, OnFailure: actiondef.FailureAlwaysRun},
	), nil)
	if result.Err == nil || !reflect.DeepEqual(order, []string{"fail", "cleanup"}) {
		t.Fatalf("result=%#v order=%v", result, order)
	}
}

func TestEngineProjectsDuplicateSemanticNodesWithOneExecution(t *testing.T) {
	calls := 0
	sink := &events{}
	h := handlerFunc{kind: actiondef.StepKindOperation, fn: func(actiondef.StepContext, actiondef.StepDefinition) actiondef.StepResult {
		calls++
		return actiondef.StepResult{Outcome: actiondef.OutcomeExecuted}
	}}
	definition := action(
		actiondef.Step{StepID: "direct-db", SharedKey: "dependency/db", StepType: actiondef.StepKindOperation},
		actiondef.Step{StepID: "transitive-db", SharedKey: "dependency/db", StepType: actiondef.StepKindOperation},
	)
	result := (&Engine{Handlers: HandlerRegistry{actiondef.StepKindOperation: h}, Events: sink, Coordinator: NewCoordinator(nil)}).Run(context.Background(), "run", definition, nil)
	if result.Err != nil || calls != 1 {
		t.Fatalf("result=%#v calls=%d", result, calls)
	}
	if !reflect.DeepEqual(sink.types, []string{"step.started:root", "step.started:direct-db", "step.completed:direct-db", "step.reference:transitive-db", "step.completed:root"}) {
		t.Fatalf("events=%v", sink.types)
	}
}

func TestEngineHonorsCancellationBeforeStartingChildren(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	h := handlerFunc{kind: actiondef.StepKindOperation, fn: func(actiondef.StepContext, actiondef.StepDefinition) actiondef.StepResult {
		calls++
		return actiondef.StepResult{}
	}}
	result := (&Engine{Handlers: HandlerRegistry{actiondef.StepKindOperation: h}}).Run(ctx, "run", action(
		actiondef.Step{StepID: "work", StepType: actiondef.StepKindOperation},
		actiondef.Step{StepID: "cleanup", StepType: actiondef.StepKindOperation, OnFailure: actiondef.FailureAlwaysRun},
	), nil)
	if result.Err == nil || calls != 1 {
		t.Fatalf("result=%#v calls=%d", result, calls)
	}
}
