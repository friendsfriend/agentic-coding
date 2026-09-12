package actionexec

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

type Event struct {
	Type        string
	RunID       actiondef.RunID
	StepID      actiondef.StepDefinitionID
	Outcome     actiondef.StepOutcome
	Label       string
	CanonicalID actiondef.StepDefinitionID
	Reference   bool
	Error       string
	At          time.Time
}

type EventSink interface{ Emit(Event) }
type HandlerRegistry map[actiondef.StepKind]actiondef.StepHandler

type Engine struct {
	Handlers    HandlerRegistry
	Events      EventSink
	Coordinator actiondef.ExecutionCoordinator
}

type RunResult struct {
	RunID   actiondef.RunID
	Outcome actiondef.StepOutcome
	Err     error
}

func (e *Engine) Run(ctx context.Context, runID actiondef.RunID, definition actiondef.Action, inputs map[actiondef.ValueKey]actiondef.Value) RunResult {
	if coordinator, ok := e.Coordinator.(*Coordinator); ok {
		defer coordinator.ClearScope(string(runID))
	}
	values := newValueStore(inputs)
	runner := runner{ctx: ctx, runID: runID, handlers: e.Handlers, events: e.Events, values: values, coordinator: e.Coordinator, canonical: map[actiondef.ExecutionKey]actiondef.StepDefinitionID{}}
	result := runner.execute(definition.Root())
	return RunResult{RunID: runID, Outcome: result.Outcome, Err: result.Err}
}

type runner struct {
	ctx         context.Context
	runID       actiondef.RunID
	handlers    HandlerRegistry
	events      EventSink
	values      *valueStore
	coordinator actiondef.ExecutionCoordinator
	canonical   map[actiondef.ExecutionKey]actiondef.StepDefinitionID
}

func (r *runner) emit(event Event) {
	if r.events != nil {
		event.At = time.Now()
		r.events.Emit(event)
	}
}
func (r *runner) execute(step actiondef.StepDefinition) actiondef.StepResult {
	if r.coordinator != nil && step.ExecutionKey() != "" {
		lease, err := r.coordinator.Acquire(r.ctx, actiondef.ExecutionKey(string(r.runID)+":"+string(step.ExecutionKey())), stepClaims(step))
		if err != nil {
			return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: err}
		}
		if !lease.Owner() {
			canonical := r.canonical[step.ExecutionKey()]
			r.emit(Event{Type: "step.reference", RunID: r.runID, StepID: step.ID(), CanonicalID: canonical, Reference: true})
			result, waitErr := lease.Wait(r.ctx)
			if waitErr != nil {
				return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: waitErr}
			}
			if lease.Outcome() == actiondef.OutcomeAlreadyRunning {
				result.Outcome = actiondef.OutcomeAlreadyRunning
			}
			return result
		}
		r.canonical[step.ExecutionKey()] = step.ID()
		result := r.executeOwned(step)
		lease.Release(result)
		return result
	}
	return r.executeOwned(step)
}

func (r *runner) executeOwned(step actiondef.StepDefinition) actiondef.StepResult {
	if err := r.ctx.Err(); err != nil && step.Kind() != actiondef.StepKindComposite && step.FailurePolicy() != actiondef.FailureAlwaysRun {
		return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: err}
	}
	r.emit(Event{Type: "step.started", RunID: r.runID, StepID: step.ID(), Label: step.Label()})
	var result actiondef.StepResult
	if step.Kind() == actiondef.StepKindComposite {
		result = r.executeComposite(step)
	} else {
		handler := r.handlers[step.Kind()]
		if handler == nil {
			result = actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: fmt.Errorf("no handler for %s", step.Kind())}
		} else {
			result = handler.Execute(&stepContext{ctx: r.ctx, runID: r.runID, stepID: step.ID(), values: r.values, events: r.events}, step)
		}
	}
	if result.Outcome == "" {
		if result.Err != nil {
			result.Outcome = actiondef.OutcomeFailed
		} else {
			result.Outcome = actiondef.OutcomeExecuted
		}
	}
	eventType := "step.completed"
	if result.Err != nil || result.Outcome == actiondef.OutcomeFailed {
		eventType = "step.failed"
	}
	event := Event{Type: eventType, RunID: r.runID, StepID: step.ID(), Outcome: result.Outcome}
	if result.Err != nil {
		event.Error = result.Err.Error()
	}
	r.emit(event)
	return result
}
func (r *runner) executeComposite(step actiondef.StepDefinition) actiondef.StepResult {
	children := step.Children()
	failed := false
	var firstErr error
	for _, child := range children {
		always := child.FailurePolicy() == actiondef.FailureAlwaysRun || child.Condition() == actiondef.ConditionAlways
		if failed && !always {
			continue
		}
		if !failed && child.Condition() == actiondef.ConditionOnFailure {
			continue
		}
		result := r.execute(child)
		if result.Err != nil || result.Outcome == actiondef.OutcomeFailed {
			failed = true
			if firstErr == nil {
				firstErr = result.Err
			}
		}
	}
	if failed {
		if firstErr == nil {
			firstErr = fmt.Errorf("child step failed")
		}
		return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: firstErr}
	}
	return actiondef.StepResult{Outcome: actiondef.OutcomeExecuted}
}

func stepClaims(definition actiondef.StepDefinition) []string {
	step, ok := definition.(actiondef.Step)
	if !ok || step.Configuration == nil {
		return nil
	}
	return stringSlice(step.Configuration["resourceClaims"])
}

type valueStore struct {
	mu     sync.RWMutex
	values map[actiondef.ValueKey]actiondef.Value
}

func newValueStore(inputs map[actiondef.ValueKey]actiondef.Value) *valueStore {
	copy := map[actiondef.ValueKey]actiondef.Value{}
	for k, v := range inputs {
		copy[k] = v
	}
	return &valueStore{values: copy}
}
func (s *valueStore) get(key actiondef.ValueKey) (actiondef.Value, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.values[key]
	return v, ok
}
func (s *valueStore) set(key actiondef.ValueKey, value actiondef.Value) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = value
}

type stepContext struct {
	ctx    context.Context
	runID  actiondef.RunID
	stepID actiondef.StepDefinitionID
	values *valueStore
	events EventSink
}

func (c *stepContext) Context() context.Context           { return c.ctx }
func (c *stepContext) RunID() actiondef.RunID             { return c.runID }
func (c *stepContext) StepID() actiondef.StepDefinitionID { return c.stepID }
func (c *stepContext) Require(key actiondef.ValueKey) (actiondef.Value, error) {
	v, ok := c.values.get(key)
	if !ok {
		return v, fmt.Errorf("required value %s missing", key)
	}
	return v, nil
}
func (c *stepContext) Set(key actiondef.ValueKey, v actiondef.Value) error {
	c.values.set(key, v)
	return nil
}
func (c *stepContext) Executor() actiondef.CommandExecutor { return nil }
func (c *stepContext) Events() actiondef.EventSink         { return c.events }
func (c *stepContext) Secrets() actiondef.SecretResolver   { return nil }
