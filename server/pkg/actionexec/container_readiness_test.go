package actionexec

import (
	"context"
	"testing"
	"time"
)

func TestContainerHealthProbePollsUntilHealthy(t *testing.T) {
	calls := 0
	runner := commandRunnerFunc(func(context.Context, CommandSpec, func(string, string)) CommandResult {
		calls++
		if calls == 1 {
			return CommandResult{Stdout: "running starting"}
		}
		return CommandResult{Stdout: "running healthy"}
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := (ContainerHealthProbe{Runner: runner, Container: "api", Interval: time.Millisecond}).Wait(ctx); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("calls=%d", calls)
	}
}
