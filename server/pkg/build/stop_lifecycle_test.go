package build

import (
	"reflect"
	"testing"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/docker"
	"github.com/friendsfriend/devenv/pkg/resources"
	"github.com/friendsfriend/devenv/pkg/state"
	"github.com/friendsfriend/devenv/pkg/status"
)

func TestStopAppUsesRecordedDockerTargetComposeFile(t *testing.T) {
	appDir := t.TempDir()
	composePath := "/config/apps/run/web-redis.compose.yml"
	targetID := resources.AppRunTargetID("web", resources.ActionRuntimeDocker, "redis")
	target := resources.ActionTarget{ID: targetID, Action: resources.AppActionRun, Runtime: resources.ActionRuntimeDocker, Label: "redis", Profile: "redis", SourcePath: composePath}
	runner := &fakeCommandRunner{}
	statusMgr := status.NewManager()
	svc := NewService(&fakeResourceMgr{targets: []resources.ActionTarget{target}}, runner, statusMgr, t.TempDir())
	completed := ""
	svc.SetOnComplete(func(appIdent string) { completed = appIdent })
	svc.SetRunTargetInfo("web", target)

	svc.StopAppWithStatus(&app.App{Ident: "web", LocalDirectoryPath: appDir}, "")

	wantArgs := []string{"-p", "devenv", "-f", composePath, "down", "--remove-orphans"}
	if runner.lastCmd != "docker-compose" || !reflect.DeepEqual(runner.lastArgs, wantArgs) {
		t.Fatalf("stop command = %q %#v, want docker-compose %#v", runner.lastCmd, runner.lastArgs, wantArgs)
	}
	if _, ok := svc.RunTargetInfo("web"); ok {
		t.Fatal("expected successful stop to clear recorded run target info")
	}
	if got := statusMgr.GetStatus("web"); got == nil || got.StatusType != status.StatusCompleted || got.Message != "stop successful" {
		t.Fatalf("status = %#v, want completed stop successful", got)
	}
	if completed != "web" {
		t.Fatalf("OnComplete app = %q, want web", completed)
	}
}

func TestStopAppPodmanRecordedTargetUsesConfiguredComposeFile(t *testing.T) {
	defer docker.SetRuntimeForTest(docker.Runtime{Name: "podman", Command: "podman"})()
	appDir := t.TempDir()
	composePath := "/config/devenv/apps/run/api-dev.compose.yml"
	targetID := resources.AppRunTargetID("api", resources.ActionRuntimeDocker, "dev")
	target := resources.ActionTarget{ID: targetID, Action: resources.AppActionRun, Runtime: resources.ActionRuntimeDocker, Label: "dev", Profile: "dev", SourcePath: composePath}
	runner := &fakeCommandRunner{}
	svc := NewService(&fakeResourceMgr{targets: []resources.ActionTarget{target}}, runner, status.NewManager(), t.TempDir())
	svc.SetRunTargetInfo("api", target)

	svc.StopAppWithStatus(&app.App{Ident: "api", LocalDirectoryPath: appDir}, "")

	if runner.lastCmd != "podman-compose" {
		t.Fatalf("command = %q, want podman-compose", runner.lastCmd)
	}
	if !containsArg(runner.lastArgs, "-f") || !containsArg(runner.lastArgs, composePath) {
		t.Fatalf("expected -f %q in args, got %#v", composePath, runner.lastArgs)
	}
	if len(runner.lastArgs) >= 1 && runner.lastArgs[0] == "down" {
		t.Fatalf("emitted unqualified podman-compose down: %#v", runner.lastArgs)
	}
}

func TestStopAppUsesPersistedRunTargetInfoAfterRestart(t *testing.T) {
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	defer store.Close()

	composePath := "/config/apps/run/worker-debug.compose.yml"
	targetID := resources.AppRunTargetID("worker", resources.ActionRuntimeDocker, "debug")
	target := resources.ActionTarget{ID: targetID, Action: resources.AppActionRun, Runtime: resources.ActionRuntimeDocker, Label: "debug", Profile: "debug", SourcePath: composePath}
	starter := NewService(&fakeResourceMgr{targets: []resources.ActionTarget{target}}, &fakeCommandRunner{}, status.NewManager(), t.TempDir())
	starter.ConfigureStateStore(store)
	starter.SetRunTargetInfo("worker", target)

	runner := &fakeCommandRunner{}
	restarted := NewService(&fakeResourceMgr{targets: []resources.ActionTarget{target}}, runner, status.NewManager(), t.TempDir())
	restarted.ConfigureStateStore(store)
	restarted.StopAppWithStatus(&app.App{Ident: "worker", LocalDirectoryPath: t.TempDir()}, "")

	wantArgs := []string{"-p", "devenv", "-f", composePath, "down", "--remove-orphans"}
	if runner.lastCmd != "docker-compose" || !reflect.DeepEqual(runner.lastArgs, wantArgs) {
		t.Fatalf("stop command = %q %#v, want docker-compose %#v", runner.lastCmd, runner.lastArgs, wantArgs)
	}
	fresh := NewService(&fakeResourceMgr{}, &fakeCommandRunner{}, status.NewManager(), t.TempDir())
	fresh.ConfigureStateStore(store)
	if _, ok := fresh.RunTargetInfo("worker"); ok {
		t.Fatal("expected persisted run target info cleared after stop")
	}
}

func TestStopAppFallbackComposeIncludesConfiguredComposeAndEnvFile(t *testing.T) {
	appDir := t.TempDir()
	composePath := "/config/apps/run/default.compose.yml"
	envPath := "/config/.env"
	runner := &fakeCommandRunner{}
	svc := NewService(&fakeResourceMgr{targets: []resources.ActionTarget{}, composePath: composePath, envFilePath: envPath}, runner, status.NewManager(), t.TempDir())

	svc.StopAppWithStatus(&app.App{Ident: "web", LocalDirectoryPath: appDir}, "")

	wantArgs := []string{"-p", "devenv", "--env-file", envPath, "-f", composePath, "down", "--remove-orphans"}
	if runner.lastCmd != "docker-compose" || !reflect.DeepEqual(runner.lastArgs, wantArgs) {
		t.Fatalf("fallback stop command = %q %#v, want docker-compose %#v", runner.lastCmd, runner.lastArgs, wantArgs)
	}
}

func containsArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}
