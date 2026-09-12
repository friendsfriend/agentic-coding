package kubernetes

import (
	"reflect"
	"testing"

	"github.com/friendsfriend/devenv/pkg/resources"
)

func boolPtr(v bool) *bool { return &v }

func TestResolveImageBuildCommands(t *testing.T) {
	cfg := &resources.KubernetesImageConfig{Repository: "repo/app", Tag: "dev", Build: &resources.KubernetesImageBuildConfig{Context: "/src", Dockerfile: "/src/Dockerfile", Enabled: boolPtr(true)}}
	plan, ok := ResolveImageBuild("app", "/app", cfg, "docker")
	if !ok {
		t.Fatal("expected plan")
	}
	want := []string{"build", "-f", "/src/Dockerfile", "-t", "repo/app:dev", "/src"}
	if plan.Command.Name != "docker" || !reflect.DeepEqual(plan.Command.Args, want) {
		t.Fatalf("docker command = %#v", plan.Command)
	}
	plan, ok = ResolveImageBuild("app", "/app", cfg, "podman")
	if !ok || plan.Command.Name != "podman" {
		t.Fatalf("podman command = %#v ok=%v", plan.Command, ok)
	}
	shortCfg := &resources.KubernetesImageConfig{Repository: "app", Tag: "dev", Build: &resources.KubernetesImageBuildConfig{Context: "/src", Dockerfile: "/src/Dockerfile"}}
	plan, ok = ResolveImageBuild("app", "/app", shortCfg, "podman")
	if !ok || plan.Image != "localhost/app:dev" || plan.Repository != "localhost/app" {
		t.Fatalf("podman short image plan = %#v ok=%v", plan, ok)
	}
}

func TestResolveImageReference(t *testing.T) {
	cfg := &resources.KubernetesImageConfig{Repository: "app", Tag: "latest", PullPolicy: "IfNotPresent"}
	plan, ok := ResolveImageReference("app", cfg, "podman")
	if !ok || plan.Image != "localhost/app:latest" || plan.Repository != "localhost/app" {
		t.Fatalf("podman image ref = %#v ok=%v", plan, ok)
	}
	plan, ok = ResolveImageReference("app", cfg, "docker")
	if !ok || plan.Image != "app:latest" || plan.Repository != "app" {
		t.Fatalf("docker image ref = %#v ok=%v", plan, ok)
	}
}

func TestKindLoadImageCommand(t *testing.T) {
	r := Runner{ClusterName: "devenv", KindCommand: "kind"}
	cmd := r.KindLoadImageCommand("repo/app:dev")
	want := []string{"load", "docker-image", "repo/app:dev", "--name", "devenv"}
	if !reflect.DeepEqual(cmd.Args, want) {
		t.Fatalf("kind load args = %#v", cmd.Args)
	}
}

func TestHelmImageOverrides(t *testing.T) {
	cfg := resources.KubernetesImageConfig{ValuePaths: resources.KubernetesImageValuePaths{Repository: "image.repository", Tag: "image.tag", PullPolicy: "image.pullPolicy"}}
	got := HelmImageOverrides(cfg, ImageBuildPlan{Repository: "repo/app", Tag: "dev", PullPolicy: "IfNotPresent"})
	want := []string{"--set-string", "image.repository=repo/app", "--set-string", "image.tag=dev", "--set-string", "image.pullPolicy=IfNotPresent"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("overrides = %#v", got)
	}
}
