package actionexec

import (
	"context"
	"sort"
	"strings"
	"sync"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

type LeaseState string

const (
	LeaseOwner          LeaseState = "owner"
	LeaseSharedRunning  LeaseState = "shared-running"
	LeaseCompleted      LeaseState = "completed"
	LeaseAlreadyRunning LeaseState = "already-running"
)

type execution struct {
	done     chan struct{}
	result   actiondef.StepResult
	complete bool
}
type Coordinator struct {
	mu         sync.Mutex
	executions map[actiondef.ExecutionKey]*execution
	claims     map[string]actiondef.ExecutionKey
	ready      func(actiondef.ExecutionKey) bool
}

func NewCoordinator(ready func(actiondef.ExecutionKey) bool) *Coordinator {
	return &Coordinator{executions: map[actiondef.ExecutionKey]*execution{}, claims: map[string]actiondef.ExecutionKey{}, ready: ready}
}

func (c *Coordinator) Acquire(ctx context.Context, key actiondef.ExecutionKey, claims []string) (actiondef.ExecutionLease, error) {
	c.mu.Lock()
	if c.ready != nil && c.ready(key) {
		c.mu.Unlock()
		return &Lease{state: LeaseAlreadyRunning, result: actiondef.StepResult{Outcome: actiondef.OutcomeAlreadyRunning}}, nil
	}
	if existing := c.executions[key]; existing != nil {
		state := LeaseSharedRunning
		if existing.complete {
			state = LeaseCompleted
		}
		lease := &Lease{state: state, execution: existing}
		c.mu.Unlock()
		return lease, nil
	}
	sorted := append([]string(nil), claims...)
	sort.Strings(sorted)
	for _, claim := range sorted {
		if owner, used := c.claims[claim]; used && owner != key {
			c.mu.Unlock()
			return nil, &ClaimConflict{Claim: claim, Owner: owner}
		}
	}
	for _, claim := range sorted {
		c.claims[claim] = key
	}
	exec := &execution{done: make(chan struct{})}
	c.executions[key] = exec
	c.mu.Unlock()
	return &Lease{state: LeaseOwner, execution: exec, coordinator: c, key: key, claims: sorted}, nil
}

func (c *Coordinator) ClearScope(scope string) {
	prefix := scope + ":"
	c.mu.Lock()
	defer c.mu.Unlock()
	for key := range c.executions {
		if strings.HasPrefix(string(key), prefix) {
			delete(c.executions, key)
		}
	}
}

type ClaimConflict struct {
	Claim string
	Owner actiondef.ExecutionKey
}

func (e *ClaimConflict) Error() string { return "resource claim already held: " + e.Claim }

type Lease struct {
	state       LeaseState
	execution   *execution
	coordinator *Coordinator
	key         actiondef.ExecutionKey
	claims      []string
	result      actiondef.StepResult
	once        sync.Once
}

func (l *Lease) State() LeaseState { return l.state }
func (l *Lease) Owner() bool       { return l.state == LeaseOwner }
func (l *Lease) Outcome() actiondef.StepOutcome {
	if l.state == LeaseAlreadyRunning {
		return actiondef.OutcomeAlreadyRunning
	}
	if l.execution != nil && l.execution.complete {
		return l.execution.result.Outcome
	}
	return l.result.Outcome
}
func (l *Lease) Wait(ctx context.Context) (actiondef.StepResult, error) {
	if l.state == LeaseAlreadyRunning {
		return l.result, nil
	}
	select {
	case <-ctx.Done():
		return actiondef.StepResult{}, ctx.Err()
	case <-l.execution.done:
		return l.execution.result, nil
	}
}
func (l *Lease) Release(result actiondef.StepResult) {
	if !l.Owner() {
		return
	}
	l.once.Do(func() {
		c := l.coordinator
		c.mu.Lock()
		l.execution.result = result
		l.execution.complete = true
		close(l.execution.done)
		for _, claim := range l.claims {
			if c.claims[claim] == l.key {
				delete(c.claims, claim)
			}
		}
		c.mu.Unlock()
	})
}
