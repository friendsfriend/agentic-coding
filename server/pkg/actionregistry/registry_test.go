package actionregistry

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/actiondef"
	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/resources"
)

type provider struct {
	name    string
	actions []actiondef.Action
	err     error
}

func (p provider) Name() string                                        { return p.name }
func (p provider) Compile(context.Context) ([]actiondef.Action, error) { return p.actions, p.err }

type handler struct{ kind actiondef.StepKind }

func (h handler) Supports(k actiondef.StepKind) bool { return h.kind == k }
func (h handler) Execute(actiondef.StepContext, actiondef.StepDefinition) actiondef.StepResult {
	return actiondef.StepResult{Outcome: actiondef.OutcomeExecuted}
}

func targetAction(app, profile string) actiondef.Action {
	return CompileTarget(app, resources.ActionTarget{ID: "legacy", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, Label: "Dev", Profile: profile, Command: "sh"})
}

func TestRegistryPublishesAtomicImmutableSnapshots(t *testing.T) {
	r := New()
	handlers := actiondef.HandlerSet{actiondef.StepKindProcess: handler{actiondef.StepKindProcess}}
	first, err := r.Rebuild(context.Background(), []Provider{provider{name: "targets", actions: []actiondef.Action{targetAction("api", "dev")}}}, handlers)
	if err != nil {
		t.Fatal(err)
	}
	if first.Version != 1 || len(first.Definitions) != 1 {
		t.Fatalf("snapshot = %#v", first)
	}
	old := first
	if _, err := r.Rebuild(context.Background(), []Provider{provider{name: "broken", err: errors.New("bad config")}}, handlers); err == nil {
		t.Fatal("expected rebuild failure")
	}
	if r.Snapshot() != old {
		t.Fatal("failed rebuild replaced valid snapshot")
	}
	definition, ok := old.Get("app/api/action/run/shell/dev")
	if !ok || definition.Resource.ID != "api" {
		t.Fatalf("definition = %#v, ok=%v", definition, ok)
	}
}

func TestRegistryRejectsDuplicateStableIDs(t *testing.T) {
	r := New()
	action := targetAction("api", "dev")
	handlers := actiondef.HandlerSet{actiondef.StepKindProcess: handler{actiondef.StepKindProcess}}
	_, err := r.Rebuild(context.Background(), []Provider{provider{name: "one", actions: []actiondef.Action{action}}, provider{name: "two", actions: []actiondef.Action{action}}}, handlers)
	if err == nil {
		t.Fatal("expected duplicate error")
	}
	if r.Snapshot().Version != 0 {
		t.Fatal("invalid snapshot published")
	}
}

func TestCompileInfrastructureCreatesLifecycleGraphs(t *testing.T) {
	definitions := CompileInfrastructure(app.InfraService{Ident: "clock", DisplayName: "Clock", Type: app.InfraServiceTypeScript, ShellPath: "/config/clock.sh"})
	if len(definitions) != 2 {
		t.Fatalf("definitions = %d", len(definitions))
	}
	if definitions[0].ActionID != "infra/clock/action/start/shell/default" || len(definitions[0].RootStep.ChildSteps) != 2 {
		t.Fatalf("start definition = %#v", definitions[0])
	}
	if definitions[0].RootStep.ChildSteps[0].StepType != actiondef.StepKindProcess || definitions[0].RootStep.ChildSteps[1].StepType != actiondef.StepKindReadiness {
		t.Fatalf("start steps = %#v", definitions[0].RootStep.ChildSteps)
	}
}

func TestCompileRunGraphPreservesSharedSemanticDependencies(t *testing.T) {
	db := resources.ActionTarget{ID: "db", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeDocker, Profile: "default"}
	backend := resources.ActionTarget{ID: "backend", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeDocker, Requires: []resources.DependencyRef{{App: "db", Runtime: "docker", Profile: "default"}}}
	frontend := resources.ActionTarget{ID: "frontend", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeDocker, Requires: []resources.DependencyRef{{App: "db", Runtime: "docker", Profile: "default"}, {App: "backend", Runtime: "docker"}}}
	resolver := func(ref resources.DependencyRef) (string, resources.ActionTarget, bool) {
		if ref.App == "db" {
			return "db", db, true
		}
		if ref.App == "backend" {
			return "backend", backend, true
		}
		return "", resources.ActionTarget{}, false
	}
	definition := CompileTargetGraph("frontend", frontend, resolver)
	steps := definition.RootStep.ChildSteps
	if len(steps) != 5 {
		t.Fatalf("root steps=%#v", steps)
	}
	direct := steps[0]
	transitive := steps[1].ChildSteps[0]
	if direct.SharedKey != "dependency/db/docker/default" || transitive.SharedKey != direct.SharedKey || direct.StepID == transitive.StepID {
		t.Fatalf("direct=%#v transitive=%#v", direct, transitive)
	}
}

func TestCompileDependencyUsesResolvedPodmanProvider(t *testing.T) {
	target := resources.ActionTarget{ID: "api", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeDocker, Profile: "default", Requires: []resources.DependencyRef{{Infra: "redis", Runtime: "docker", Profile: "local", Provider: resources.ContainerProviderPodman}}}
	infra := resources.ActionTarget{ID: "infra/redis", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeDocker, Profile: "local", Provider: resources.ContainerProviderPodman, SourcePath: "/repo/compose.yml", WorkingDir: "/infra"}
	definition := CompileTargetGraph("api", target, func(resources.DependencyRef) (string, resources.ActionTarget, bool) { return "redis", infra, true }, "/repo")
	dependency := definition.RootStep.ChildSteps[0].ChildSteps[0]
	if dependency.Configuration["command"] != "podman-compose" || dependency.Configuration["dir"] != "/infra" {
		t.Fatalf("dependency configuration=%#v", dependency.Configuration)
	}
}

func TestCompilePodmanActionUsesPodmanForImplicitComposeDependency(t *testing.T) {
	target := resources.ActionTarget{ID: "api", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeDocker, Requires: []resources.DependencyRef{{Infra: "redis"}}}
	infra := resources.ActionTarget{ID: "infra/redis", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeDocker, Provider: resources.ContainerProviderDocker, SourcePath: "/infra/redis-compose.yml"}
	actions := CompileContainerTargets("api", target, func(resources.DependencyRef) (string, resources.ActionTarget, bool) { return "redis", infra, true }, "/repo")
	podman := actions[1]
	if podman.ActionRuntime != "podman" {
		t.Fatalf("actions=%#v", actions)
	}
	start := podman.RootStep.ChildSteps[0].ChildSteps[0]
	if start.Configuration["command"] != "podman-compose" {
		t.Fatalf("dependency configuration=%#v", start.Configuration)
	}
}

func TestTmuxUsesScriptDirectoryWhenCheckoutMissing(t *testing.T) {
	target := resources.ActionTarget{Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, Profile: "check", Label: "Check", SourcePath: "/config/apps/run/check.sh", Command: "sh", Args: []string{"/config/apps/run/check.sh"}}
	action := compileTmuxAction("check", target, nil, "/missing-checkout")
	args, _ := action.RootStep.ChildSteps[0].Configuration["args"].([]string)
	if !slices.Contains(args, "/config/apps/run") {
		t.Fatalf("tmux args=%#v", args)
	}
}

func TestCompileDependencyLifecycleModes(t *testing.T) {
	for _, lifecycle := range []string{"shared", "owned", "external"} {
		target := resources.ActionTarget{ID: "api", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, Profile: "dev", Requires: []resources.DependencyRef{{Infra: "db", Lifecycle: lifecycle}}}
		infra := resources.ActionTarget{ID: "infra/db", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, Profile: "default", Command: "sh", SourcePath: "/tmp/db.sh"}
		definition := CompileTargetGraph("api", target, func(resources.DependencyRef) (string, resources.ActionTarget, bool) { return "db", infra, true }, "/repo")
		dep := definition.RootStep.ChildSteps[0]
		if dep.Configuration["lifecycle"] != lifecycle {
			t.Fatalf("lifecycle=%q config=%#v", lifecycle, dep.Configuration)
		}
		if lifecycle == "external" && len(dep.ChildSteps) != 1 {
			t.Fatalf("external dependency must not start target: %#v", dep.ChildSteps)
		}
	}
}

func TestCompileDockerBuildCreatesTypedArtifactGraph(t *testing.T) {
	definition := CompileTarget("api", resources.ActionTarget{ID: "docker", Action: resources.AppActionBuild, Runtime: resources.ActionRuntimeDocker, Label: "Docker", SourcePath: "/repo/Dockerfile"})
	steps := definition.RootStep.ChildSteps
	want := []string{"Prepare build context", "Build image", "Clean up build context", "Prune old images", "Inspect artifacts", "Create artifact extractor", "Copy artifacts", "Remove artifact extractor"}
	if len(steps) != len(want) {
		t.Fatalf("steps=%d want=%d steps=%#v", len(steps), len(want), steps)
	}
	for i, label := range want {
		if steps[i].DisplayLabel != label {
			t.Fatalf("step %d=%#v", i, steps[i])
		}
	}
	buildArgs, ok := steps[1].Configuration["args"].([]string)
	if !ok || len(buildArgs) < 5 || buildArgs[4] != "devenv-api:latest" || steps[1].Configuration["setValues"].(map[string]any)["image.ref"] != "devenv-api:latest" {
		t.Fatalf("build configuration=%#v", steps[1].Configuration)
	}
	// Clean up build context (index 2) runs always; Remove extractor (index 7) runs always.
	if steps[2].OnFailure != actiondef.FailureAlwaysRun || steps[7].OnFailure != actiondef.FailureAlwaysRun || steps[5].OutputPorts[0].Key != "artifact.container.id" {
		t.Fatalf("artifact graph=%#v", steps)
	}
	// Every successful build immediately removes superseded dangling images.
	pruneArgs, ok := steps[3].Configuration["args"].([]string)
	wantPrune := "docker builder prune -f && docker image prune -f && docker volume prune -f"
	if !ok || len(pruneArgs) != 2 || pruneArgs[0] != "-c" || pruneArgs[1] != wantPrune {
		t.Fatalf("build prune command=%#v", steps[3].Configuration)
	}
	if strings.Contains(pruneArgs[1], "--all") {
		t.Fatalf("build prune must preserve tagged images: %q", pruneArgs[1])
	}
}

func TestCompilePodmanBuildPrunesWithoutBuilderAliasOrAll(t *testing.T) {
	target := resources.ActionTarget{ID: "docker", Action: resources.AppActionBuild, Runtime: resources.ActionRuntimeDocker, Label: "Docker", SourcePath: "/repo/Dockerfile"}
	definitions := CompileContainerTargetsWithTools("api", target, nil, ToolSet{Podman: true, PodmanCompose: true}, "/repo")
	if len(definitions) != 1 || definitions[0].ActionRuntime != "podman" {
		t.Fatalf("definitions=%#v", definitions)
	}
	steps := definitions[0].RootStep.ChildSteps
	pruneArgs, ok := steps[3].Configuration["args"].([]string)
	wantPrune := "podman image prune -f && podman volume prune -f"
	if !ok || len(pruneArgs) != 2 || pruneArgs[1] != wantPrune {
		t.Fatalf("podman prune command=%#v", steps[3].Configuration)
	}
	if strings.Contains(pruneArgs[1], "builder prune") || strings.Contains(pruneArgs[1], "--all") {
		t.Fatalf("podman prune must preserve tagged images: %q", pruneArgs[1])
	}
}

func TestCompileTargetStableIDIgnoresCheckoutPath(t *testing.T) {
	one := resources.ActionTarget{ID: "one", Action: resources.AppActionBuild, Runtime: resources.ActionRuntimeDocker, Label: "Docker", SourcePath: "/checkout-one/Dockerfile"}
	two := one
	two.SourcePath = "/checkout-two/Dockerfile"
	if CompileTarget("api", one).ActionID != CompileTarget("api", two).ActionID {
		t.Fatal("checkout path changed stable id")
	}
	compiled := CompileTarget("api", one)
	if compiled.ActionID != "app/api/action/build/docker/default" {
		t.Fatalf("id = %s", compiled.ActionID)
	}
	if compiled.AvailabilityState.Available || compiled.AvailabilityState.Reason == "" {
		t.Fatalf("availability = %#v", compiled.AvailabilityState)
	}
}
