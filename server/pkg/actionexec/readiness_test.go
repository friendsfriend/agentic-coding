package actionexec

import (
	"context"
	"testing"
	"time"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

type probeRunner struct{ result CommandResult }

func (p probeRunner) Run(context.Context, CommandSpec, func(string, string)) CommandResult {
	return p.result
}

type sequenceProbeRunner struct {
	results []CommandResult
	specs   []CommandSpec
}

func (r *sequenceProbeRunner) Run(_ context.Context, spec CommandSpec, _ func(string, string)) CommandResult {
	r.specs = append(r.specs, spec)
	result := r.results[0]
	r.results = r.results[1:]
	return result
}

func TestKubernetesPodReadinessWaitsForFirstPod(t *testing.T) {
	runner := &sequenceProbeRunner{results: []CommandResult{{}, {Stdout: "pod/postgres\n"}, {}}}
	probe := KubernetesPodReadinessProbe{Runner: runner, Context: "kind-test", Namespace: "apps", Selector: "app.kubernetes.io/instance=postgres", Timeout: "1s", Interval: time.Millisecond}
	if err := probe.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(runner.specs) != 3 || runner.specs[2].Args[len(runner.specs[2].Args)-4] != "-l" {
		t.Fatalf("commands=%#v", runner.specs)
	}
}

func TestKubernetesReadinessRunsProbeCommand(t *testing.T) {
	factory := StandardProbeFactory{Kubernetes: func(step actiondef.Step) ReadinessProbe {
		return CommandProbe{Runner: probeRunner{result: CommandResult{}}, Spec: CommandSpec{Name: "kubectl", Args: []string{"wait", step.DisplayLabel}}}
	}}
	step := actiondef.Step{StepID: "ready", StepType: actiondef.StepKindReadiness, Configuration: map[string]any{"probe": "kubernetes"}, DisplayLabel: "release"}
	probe, err := factory.Probe(nil, step)
	if err != nil {
		t.Fatal(err)
	}
	if err := probe.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
}
