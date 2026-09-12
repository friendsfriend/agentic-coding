package actionexec

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

func TestCoordinatorSharesConcurrentExecutionAndResult(t *testing.T) {
	coordinator := NewCoordinator(nil)
	owner, err := coordinator.Acquire(context.Background(), "dep/db", []string{"container:db"})
	if err != nil || !owner.Owner() {
		t.Fatalf("owner=%#v err=%v", owner, err)
	}
	shared, err := coordinator.Acquire(context.Background(), "dep/db", []string{"container:db"})
	if err != nil || shared.Owner() {
		t.Fatalf("shared=%#v err=%v", shared, err)
	}
	done := make(chan actiondef.StepResult, 1)
	go func() { result, _ := shared.Wait(context.Background()); done <- result }()
	owner.Release(actiondef.StepResult{Outcome: actiondef.OutcomeExecuted})
	select {
	case result := <-done:
		if result.Outcome != actiondef.OutcomeExecuted {
			t.Fatalf("result=%#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("shared waiter blocked")
	}
}

func TestCoordinatorRetriesCompletedFailure(t *testing.T) {
	coordinator := NewCoordinator(nil)
	first, err := coordinator.Acquire(context.Background(), "run:dep/db", nil)
	if err != nil || !first.Owner() {
		t.Fatalf("first=%#v err=%v", first, err)
	}
	first.Release(actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: errors.New("pull failed")})
	coordinator.ClearScope("run")
	retry, err := coordinator.Acquire(context.Background(), "run:dep/db", nil)
	if err != nil || !retry.Owner() {
		t.Fatalf("retry=%#v err=%v", retry, err)
	}
}

func TestCoordinatorAlreadyRunningHasNoOwner(t *testing.T) {
	var checks atomic.Int32
	coordinator := NewCoordinator(func(actiondef.ExecutionKey) bool { checks.Add(1); return true })
	lease, err := coordinator.Acquire(context.Background(), "dep/db", nil)
	if err != nil || lease.Owner() || lease.Outcome() != actiondef.OutcomeAlreadyRunning {
		t.Fatalf("lease=%#v err=%v", lease, err)
	}
	if checks.Load() != 1 {
		t.Fatal("readiness not checked")
	}
}

func TestCoordinatorOrdersAndReleasesClaims(t *testing.T) {
	coordinator := NewCoordinator(nil)
	one, err := coordinator.Acquire(context.Background(), "one", []string{"b", "a"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := coordinator.Acquire(context.Background(), "two", []string{"a"}); err == nil {
		t.Fatal("expected conflict")
	} else {
		var conflict *ClaimConflict
		if !errors.As(err, &conflict) {
			t.Fatalf("error=%v", err)
		}
	}
	one.Release(actiondef.StepResult{Outcome: actiondef.OutcomeFailed})
	two, err := coordinator.Acquire(context.Background(), "two", []string{"a"})
	if err != nil || !two.Owner() {
		t.Fatalf("two=%#v err=%v", two, err)
	}
}
