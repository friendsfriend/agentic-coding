package actionexec

import (
	"context"
	"testing"
	"time"
)

type composeRunner struct {
	out string
	err error
}

func (r composeRunner) Run(context.Context, CommandSpec, func(string, string)) CommandResult {
	return CommandResult{Stdout: r.out, Err: r.err}
}
func TestComposeReadinessRejectsNonRunningState(t *testing.T) {
	p := ComposeReadinessProbe{Runner: composeRunner{out: "running\nexited\n"}, Name: "docker", Interval: 0}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := p.Wait(ctx); err == nil {
		t.Fatal("expected unhealthy compose state")
	}
}

type recordingComposeRunner struct {
	composeRunner
	spec CommandSpec
}

func (r *recordingComposeRunner) Run(ctx context.Context, spec CommandSpec, output func(string, string)) CommandResult {
	r.spec = spec
	return r.composeRunner.Run(ctx, spec, output)
}

func TestPodmanComposeReadinessDoesNotUseDockerOnlyAllFlag(t *testing.T) {
	runner := &recordingComposeRunner{composeRunner: composeRunner{out: "running\n"}}
	probe := ComposeReadinessProbe{Runner: runner, Name: "podman-compose", Interval: 0}
	if err := probe.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, arg := range runner.spec.Args {
		if arg == "--all" {
			t.Fatalf("podman-compose args=%v", runner.spec.Args)
		}
	}
}

func TestComposeReadinessAcceptsRunningStates(t *testing.T) {
	p := ComposeReadinessProbe{Runner: composeRunner{out: "running\nrunning\n"}, Name: "docker", Interval: 0}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := p.Wait(ctx); err != nil {
		t.Fatal(err)
	}
}
