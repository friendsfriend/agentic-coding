package actionregistry

import (
	"reflect"
	"slices"
	"testing"

	"github.com/friendsfriend/devenv/pkg/actiondef"
	"github.com/friendsfriend/devenv/pkg/resources"
)

func TestKubernetesProviderUsesScopedEnvironmentAndArchive(t *testing.T) {
	target := resources.ActionTarget{ID: "k8s", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeKubernetes, Provider: resources.ContainerProviderPodman, Kubernetes: &resources.KubernetesTargetMetadata{Provider: resources.ContainerProviderPodman, ClusterName: "podman-local", ContextName: "kind-podman-local", ChartPath: "chart", Release: "api", Namespace: "apps", Image: &resources.KubernetesImageConfig{Repository: "api", Tag: "latest"}}}
	action := CompileTargetGraph("api", target, nil, "/repo")
	var ensure, load actiondef.Step
	for _, step := range action.RootStep.ChildSteps {
		if step.DisplayLabel == "Ensure cluster" {
			ensure = step
		}
		if step.DisplayLabel == "Load image" {
			load = step
		}
	}
	if len(ensure.Configuration["env"].([]string)) != 1 || ensure.Configuration["env"].([]string)[0] != "KIND_EXPERIMENTAL_PROVIDER=podman" {
		t.Fatalf("ensure=%#v", ensure.Configuration)
	}
	if args := load.Configuration["args"].([]string); len(args) < 2 || args[1] == "/tmp/devenv-image.tar" {
		t.Fatalf("load args=%#v", args)
	}
}

func TestValidateKubernetesIdentitiesRejectsExplicitProviderCollision(t *testing.T) {
	base := resources.ActionTarget{Runtime: resources.ActionRuntimeKubernetes, Provider: resources.ContainerProviderDocker, Kubernetes: &resources.KubernetesTargetMetadata{ClusterName: "shared", ContextName: "kind-shared"}}
	other := base
	other.Provider = resources.ContainerProviderPodman
	if err := ValidateKubernetesIdentities([]resources.ActionTarget{base, other}); err == nil {
		t.Fatal("expected provider collision")
	}
}

func TestCompileKubernetesTargetRequiresProviderAndKubernetesTools(t *testing.T) {
	target := resources.ActionTarget{Action: resources.AppActionRun, Runtime: resources.ActionRuntimeKubernetes, Provider: resources.ContainerProviderPodman, Kubernetes: &resources.KubernetesTargetMetadata{ChartPath: "chart", Release: "api"}}
	if actions := CompileContainerTargetsWithTools("api", target, nil, ToolSet{Podman: true}); len(actions) != 0 {
		t.Fatalf("actions=%#v", actions)
	}
}

func TestCompileKubernetesTargetIncludesReadinessDiagnosticsAndCleanup(t *testing.T) {
	definition := CompileTarget("api", resources.ActionTarget{ID: "k8s", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeKubernetes, Label: "Kubernetes", Kubernetes: &resources.KubernetesTargetMetadata{ChartPath: "chart", Release: "api", Namespace: "default"}})
	steps := definition.RootStep.ChildSteps
	seen := map[string]actiondef.Step{}
	for _, step := range steps {
		seen[step.DisplayLabel] = step
	}
	if seen["Wait for workloads"].StepType != actiondef.StepKindReadiness || seen["Collect workload diagnostics"].RunCondition != actiondef.ConditionOnFailure || seen["Clean up failed release"].OnFailure != actiondef.FailureAlwaysRun {
		t.Fatalf("steps=%#v", steps)
	}
	cleanupArgs, _ := seen["Clean up failed release"].Configuration["args"].([]string)
	if len(cleanupArgs) < 4 || cleanupArgs[3] != "${helm.release.app/api/action/run/kubernetes/default}" {
		t.Fatalf("cleanup must require current-run release value: %#v", cleanupArgs)
	}
}

func TestKubernetesStopIgnoresMissingRelease(t *testing.T) {
	actions := CompileKubernetesLifecycleActions("api", resources.ActionTarget{Action: resources.AppActionRun, Runtime: resources.ActionRuntimeKubernetes, Kubernetes: &resources.KubernetesTargetMetadata{Release: "api", Namespace: "apps"}})
	args, _ := actions[0].RootStep.ChildSteps[0].Configuration["args"].([]string)
	if !slices.Contains(args, "--ignore-not-found") {
		t.Fatalf("stop args = %#v", args)
	}
}

func TestKubernetesRestartStopsThenStarts(t *testing.T) {
	actions := CompileKubernetesLifecycleActions("api", resources.ActionTarget{Action: resources.AppActionRun, Runtime: resources.ActionRuntimeKubernetes, Kubernetes: &resources.KubernetesTargetMetadata{ChartPath: "chart", Release: "api", Namespace: "apps"}})
	steps := actions[1].RootStep.ChildSteps
	if len(steps) != 3 || steps[0].DisplayLabel != "Uninstall Helm release" || steps[1].DisplayLabel != "Install Helm release" || steps[2].DisplayLabel != "Wait for workloads" {
		t.Fatalf("restart steps=%#v", steps)
	}
	args, _ := steps[0].Configuration["args"].([]string)
	if !slices.Contains(args, "--ignore-not-found") {
		t.Fatalf("restart stop args=%#v", args)
	}
}

func TestCompileKubernetesTargetPortForwardUsesContextAndNamespace(t *testing.T) {
	definition := CompileTarget("api", resources.ActionTarget{
		ID:      "k8s",
		Action:  resources.AppActionRun,
		Runtime: resources.ActionRuntimeKubernetes,
		Label:   "Kubernetes",
		Kubernetes: &resources.KubernetesTargetMetadata{
			ChartPath: "chart",
			Release:   "api-local",
			Namespace: "apps",
			Ports: []resources.KubernetesPortForwardConfig{
				{Resource: "svc/api", LocalPort: 8080, RemotePort: 80},
			},
		},
	})
	steps := definition.RootStep.ChildSteps
	portForward := steps[len(steps)-2]
	args, ok := portForward.Configuration["args"].([]string)
	want := []string{"--context", "kind-devenv", "port-forward", "--namespace", "apps", "svc/api", "8080:80"}
	if !ok || !reflect.DeepEqual(args, want) {
		t.Fatalf("port-forward args=%#v want=%#v", args, want)
	}
	readiness := steps[len(steps)-1]
	if readiness.DisplayLabel != "Wait for port forward" || readiness.Configuration["processStepId"] != string(portForward.StepID) {
		t.Fatalf("port-forward readiness=%#v", readiness)
	}
}

func TestCompileKubernetesClusterActionsUsesOneCommandPerStep(t *testing.T) {
	tools := ToolSet{Kind: true, Kubectl: true, Helm: true, Docker: true, Podman: true}
	actions := CompileKubernetesClusterActionsWithTools(tools)
	// Two providers (docker, podman) × 5 specs each = 10 actions
	if len(actions) != 10 {
		t.Fatalf("actions=%d", len(actions))
	}
	// Docker variant is the first 5, podman variant is the second 5
	create := actions[1]
	want := []string{"Create cluster", "Export kubeconfig"}
	for i, label := range want {
		if create.RootStep.ChildSteps[i].DisplayLabel != label || create.RootStep.ChildSteps[i].StepType != "command" {
			t.Fatalf("step %d=%#v", i, create.RootStep.ChildSteps[i])
		}
	}
	exportArgs, ok := create.RootStep.ChildSteps[1].Configuration["args"].([]string)
	if !ok || !slices.Contains(exportArgs, "--kubeconfig") {
		t.Fatalf("export kubeconfig args=%#v", create.RootStep.ChildSteps[1].Configuration["args"])
	}
	// Podman variant should have KIND_EXPERIMENTAL_PROVIDER=podman env
	podmanCreate := actions[6]
	if podmanCreate.RootStep.ChildSteps[0].Configuration["env"] == nil {
		t.Fatalf("podman create cluster step missing podman env: %#v", podmanCreate.RootStep.ChildSteps[0].Configuration)
	}
}
