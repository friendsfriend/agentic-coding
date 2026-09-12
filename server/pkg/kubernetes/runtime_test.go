package kubernetes

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/docker"
)

func TestRunnerCommandsTargetManagedContext(t *testing.T) {
	r := NewRunner(docker.Runtime{Name: "docker", Command: "docker"})
	if got := r.KubectlCommandFor("get", "pods").Args; !reflect.DeepEqual(got, []string{"--context", "kind-devenv", "get", "pods"}) {
		t.Fatalf("kubectl args = %#v", got)
	}
	if got := r.HelmCommandFor("install", "app", "./chart").Args; !reflect.DeepEqual(got, []string{"--kube-context", "kind-devenv", "install", "app", "./chart"}) {
		t.Fatalf("helm args = %#v", got)
	}
}

func TestRunnerPreflightMissingTool(t *testing.T) {
	r := NewRunner(docker.Runtime{Name: "docker", Command: "docker"})
	r.LookPath = func(name string) (string, error) {
		if name == "helm" {
			return "", errors.New("not found")
		}
		return "/bin/" + name, nil
	}
	if err := r.Preflight(); err == nil || !strings.Contains(err.Error(), `missing required Kubernetes tool "helm"`) {
		t.Fatalf("Preflight error = %v", err)
	}
}

func TestRunnerKindLifecycleCommands(t *testing.T) {
	r := NewRunner(docker.Runtime{Name: "docker", Command: "docker"})
	if got := r.KindCreateClusterCommand().Args; !reflect.DeepEqual(got, []string{"create", "cluster", "--name", "devenv"}) {
		t.Fatalf("create args = %#v", got)
	}
	if got := r.KindDeleteClusterCommand().Args; !reflect.DeepEqual(got, []string{"delete", "cluster", "--name", "devenv"}) {
		t.Fatalf("delete args = %#v", got)
	}
	if got := r.KindExportKubeconfigCommand().Args; !reflect.DeepEqual(got, []string{"export", "kubeconfig", "--name", "devenv"}) {
		t.Fatalf("export args = %#v", got)
	}
}

func TestRunnerProviderEnv(t *testing.T) {
	dockerRunner := NewRunner(docker.Runtime{Name: "docker", Command: "docker"})
	if env := dockerRunner.KindCreateClusterCommand().Env; len(env) != 0 {
		t.Fatalf("docker env = %#v", env)
	}
	podmanRunner := NewRunner(docker.Runtime{Name: "podman", Command: "podman"})
	if env := podmanRunner.KindCreateClusterCommand().Env; !reflect.DeepEqual(env, []string{"KIND_EXPERIMENTAL_PROVIDER=podman"}) {
		t.Fatalf("podman env = %#v", env)
	}
	if env := podmanRunner.KindLoadImageCommand("app:dev").Env; !reflect.DeepEqual(env, []string{"KIND_EXPERIMENTAL_PROVIDER=podman"}) {
		t.Fatalf("podman load env = %#v", env)
	}
	if env := podmanRunner.KindDeleteClusterCommand().Env; !reflect.DeepEqual(env, []string{"KIND_EXPERIMENTAL_PROVIDER=podman"}) {
		t.Fatalf("podman delete env = %#v", env)
	}
}
