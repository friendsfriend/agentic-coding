package kubernetes

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/friendsfriend/devenv/pkg/docker"
)

type fakeCommandRunner struct {
	outputs map[string][]byte
	errors  map[string]error
	calls   []Command
}

func (f *fakeCommandRunner) Run(_ context.Context, cmd Command) ([]byte, error) {
	f.calls = append(f.calls, cmd)
	key := cmd.Name + " " + strings.Join(cmd.Args, " ")
	if err := f.errors[key]; err != nil {
		return f.outputs[key], err
	}
	return f.outputs[key], nil
}

func TestClusterServiceStatusParsesClusterSummary(t *testing.T) {
	fake := &fakeCommandRunner{outputs: map[string][]byte{
		"kind get clusters":                                                 []byte("devenv\n"),
		"kubectl --context kind-devenv version -o json":                     []byte(`{"serverVersion":{"gitVersion":"v1.29.0"}}`),
		"kubectl --context kind-devenv get nodes -o json":                   []byte(`{"items":[{"metadata":{"name":"devenv-control-plane"},"status":{"nodeInfo":{"kubeletVersion":"v1.29.0"},"conditions":[{"type":"Ready","status":"True"}]}}]}`),
		"kubectl --context kind-devenv get pods --all-namespaces -o json":   []byte(`{"items":[{"metadata":{"namespace":"apps"},"status":{"phase":"Running"}},{"metadata":{"namespace":"apps"},"status":{"phase":"Failed"}}]}`),
		"helm --kube-context kind-devenv list --all-namespaces -o json":     []byte(`[{"name":"api","namespace":"apps","status":"deployed","chart":"api-0.1.0","revision":"1"}]`),
		"docker ps --format {{.Names}}":                                     []byte("devenv-control-plane\n"),
		"docker stats --no-stream --format {{json .}} devenv-control-plane": []byte(`{"CPUPerc":"12.5%","MemUsage":"128MiB / 1GiB","MemPerc":"12.5%"}`),
	}}
	svc := ClusterService{Runner: NewRunner(docker.Runtime{Name: "docker", Command: "docker"}), Exec: fake, Now: func() time.Time { return time.Unix(10, 0) }}
	status := svc.Status(context.Background())
	if status.State != ClusterStateRunning || !status.Exists || !status.Reachable {
		t.Fatalf("status state = %#v", status)
	}
	if status.KubernetesVersion != "v1.29.0" || len(status.Nodes) != 1 || !status.Nodes[0].Ready {
		t.Fatalf("cluster summary = %#v", status)
	}
	if status.Pods.Total != 2 || status.Pods.Running != 1 || status.Pods.Failed != 1 {
		t.Fatalf("pod summary = %#v", status.Pods)
	}
	if status.Stats == nil || status.Stats.CPUPercent != 12.5 || status.Stats.MemoryUsageBytes != 128*(1<<20) {
		t.Fatalf("stats = %#v", status.Stats)
	}
}

func TestClusterServiceStatusSuppressesKnownKindPodmanListBugWhenMissing(t *testing.T) {
	fake := &fakeCommandRunner{
		outputs: map[string][]byte{
			"podman ps -a --format {{.Names}}": []byte(""),
		},
		errors: map[string]error{
			"kind get clusters": errors.New("using podman due to KIND_EXPERIMENTAL_PROVIDER\nenabling experimental podman provider\nERROR: failed to list clusters: command \"podman ps -a --filter label=io.x-k8s.kind.cluster --format '{{index .Labels \"io.x-k8s.kind.cluster\"}}'\" failed with error: exit status 125\nCommand Output: Error: template: ps:1:13: executing \"ps\" at <index .Labels \"io.x-k8s.kind.cluster\">: error calling index: cannot index slice/array with type string"),
		},
	}
	svc := ClusterService{Runner: NewRunner(docker.Runtime{Name: "podman", Command: "podman"}), Exec: fake}
	status := svc.Status(context.Background())
	if status.Exists || status.State != ClusterStateMissing || len(status.Warnings) != 0 {
		t.Fatalf("status = %#v", status)
	}
}

func TestClusterServiceCreateObservesLifecycleCommands(t *testing.T) {
	fake := &fakeCommandRunner{outputs: map[string][]byte{"kind get clusters": []byte("devenv\n"), "kind export kubeconfig --name devenv": []byte("exported\\n")}}
	var observed []CommandObservation
	r := NewRunner(docker.Runtime{Name: "docker", Command: "docker"})
	r.LookPath = func(name string) (string, error) { return "/bin/" + name, nil }
	svc := ClusterService{Runner: r, Exec: fake, Observe: func(observation CommandObservation) { observed = append(observed, observation) }}
	if err := svc.Create(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(observed) != 2 || observed[0].Command.Args[0] != "get" || observed[1].Command.Args[0] != "export" {
		t.Fatalf("observed = %#v", observed)
	}
	if observed[0].Output != "devenv\n" || observed[0].Err != nil {
		t.Fatalf("check observation = %#v", observed[0])
	}
}

func TestClusterServiceCreateReusesExistingAndExports(t *testing.T) {
	fake := &fakeCommandRunner{outputs: map[string][]byte{"kind get clusters": []byte("devenv\n")}}
	r := NewRunner(docker.Runtime{Name: "docker", Command: "docker"})
	r.LookPath = func(name string) (string, error) { return "/bin/" + name, nil }
	svc := ClusterService{Runner: r, Exec: fake}
	if err := svc.Create(context.Background()); err != nil {
		t.Fatal(err)
	}
	var got [][]string
	for _, call := range fake.calls {
		got = append(got, append([]string{call.Name}, call.Args...))
	}
	want := [][]string{{"kind", "get", "clusters"}, {"kind", "export", "kubeconfig", "--name", "devenv"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %#v", got)
	}
}
