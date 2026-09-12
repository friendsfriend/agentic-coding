package build

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/docker"
	"github.com/friendsfriend/devenv/pkg/resources"
)

type actionAwareSilentRunner struct{}

func (actionAwareSilentRunner) RunCommandWithLogging(string, string, []string, []string, string) (error, string) {
	return nil, ""
}
func (actionAwareSilentRunner) RunCommandWithLoggingToFile(string, string, []string, []string, string, string) (error, string) {
	return nil, ""
}
func (actionAwareSilentRunner) RunCommandSilent(string, []string, []string, string) (error, string) {
	return nil, ""
}
func (actionAwareSilentRunner) RunCommandSilentForAction(string, string, []string, []string, string) (error, string) {
	return nil, ""
}
func (actionAwareSilentRunner) RunCommandSilentForActionDisplay(string, string, []string, []string, []string, string) (error, string) {
	return nil, ""
}

func TestLogSilentCommandDoesNotRepublishActionAwareCommand(t *testing.T) {
	calls := 0
	svc := &service{
		executor: actionAwareSilentRunner{},
		actionBindings: map[string]actionBinding{"app": {
			step:    "step",
			command: func(string, string, []string) { calls++ },
			output:  func(string, string, string) { calls++ },
			done:    func(string, error) { calls++ },
		}},
		actionAppIdent: "app",
	}
	svc.logSilentCommand("", "podman", []string{"inspect"}, nil, "", "output", nil)
	if calls != 0 {
		t.Fatalf("action-aware silent command was republished %d times", calls)
	}
}

type countingHealthWaiter struct {
	calls        int
	containerIDs []string
	waitedFor    []string
}

func (w *countingHealthWaiter) WaitForHealthy(_ context.Context, container string, _ time.Duration) error {
	w.calls++
	w.waitedFor = append(w.waitedFor, container)
	return nil
}
func (w *countingHealthWaiter) GetAllContainerIDsForApp(docker.App) []string { return w.containerIDs }
func (w *countingHealthWaiter) GetContainerLogs(string) (string, error)      { return "", nil }

func TestTmuxRunTargetSkipsContainerReadiness(t *testing.T) {
	waiter := &countingHealthWaiter{}
	svc := &service{healthWaiter: waiter}
	target := resources.ActionTarget{Runtime: resources.ActionRuntimeShell, LaunchMode: resources.LaunchModeTmux}
	if err := svc.waitForRunTarget(&app.App{}, target); err != nil {
		t.Fatal(err)
	}
	if waiter.calls != 0 {
		t.Fatalf("tmux target performed %d container health checks", waiter.calls)
	}
}

func TestDockerRunTargetWaitsForResolvedProfileContainers(t *testing.T) {
	waiter := &countingHealthWaiter{containerIDs: []string{"debug-api", "debug-worker"}}
	svc := &service{healthWaiter: waiter}
	target := resources.ActionTarget{Runtime: resources.ActionRuntimeDocker, Profile: "debug"}
	if err := svc.waitForRunTarget(&app.App{Ident: "api"}, target); err != nil {
		t.Fatal(err)
	}
	if strings.Join(waiter.waitedFor, ",") != "debug-api,debug-worker" {
		t.Fatalf("waited for %v", waiter.waitedFor)
	}
}

func TestDependencyLeaseOnlyDeduplicatesConcurrentRuns(t *testing.T) {
	svc := &service{}
	first, owner := svc.acquireDependency("postgres")
	if !owner {
		t.Fatal("first acquisition must own lease")
	}
	svc.finishDependency(first, nil)
	second, owner := svc.acquireDependency("postgres")
	if !owner {
		t.Fatal("completed lease must not suppress later action")
	}
	if second == first {
		t.Fatal("later action must receive fresh lease")
	}
	svc.finishDependency(second, nil)
}

func TestBuildAppNoCheckout(t *testing.T) {
	svc := &service{
		resourceMgr: &fakeResourceMgr{},
	}

	var got string
	svc.buildAppInternal(&app.App{
		LocalDirectoryPath: "/nonexistent",
	}, "", func(s string) { got = s })

	if !strings.Contains(got, "Checkout needed") {
		t.Fatalf("expected 'Checkout needed', got %q", got)
	}
}

type fakeResourceMgr struct {
	copyTemplatesErr error
	copyTemplates    []string
	dockerfileErr    error
	composeErr       error
	composePath      string
	envFilePath      string
	envFileOK        bool
	targets          []resources.ActionTarget
}

func (f *fakeResourceMgr) ExistsDir(path string) (bool, error) {
	_, err := os.Stat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	return err == nil, err
}

func (f *fakeResourceMgr) ResolveDockerfileForAction(_, _ string, _ resources.ActionType) (string, error) {
	if f.dockerfileErr != nil {
		return "", f.dockerfileErr
	}
	return "/fake/dockerfile", nil
}

func (f *fakeResourceMgr) ResolveComposeFile(_, _ string, _ string) (string, error) {
	if f.composeErr != nil {
		return "", f.composeErr
	}
	if f.composePath != "" {
		return f.composePath, nil
	}
	return "/fake/compose.yml", nil
}

func (f *fakeResourceMgr) ResolveInfrastructureComposeFile(_ string) (string, error) {
	return "/fake/infrastructure-compose.yml", nil
}

func (f *fakeResourceMgr) DiscoverProfiles(_, _ string) ([]string, error) {
	return nil, nil
}

func (f *fakeResourceMgr) DiscoverActionTargets(_, _ string, action resources.AppAction) ([]resources.ActionTarget, error) {
	if f.targets != nil {
		return f.targets, nil
	}
	if action == resources.AppActionRun {
		if f.composeErr != nil {
			return nil, f.composeErr
		}
		return []resources.ActionTarget{{ID: "run:docker:default", Action: action, Runtime: resources.ActionRuntimeDocker, Label: "default", SourcePath: "/fake/compose.yml"}}, nil
	}
	if f.dockerfileErr != nil {
		return nil, f.dockerfileErr
	}
	return []resources.ActionTarget{{ID: string(action) + ":docker", Action: action, Runtime: resources.ActionRuntimeDocker, Label: "Docker", SourcePath: "/fake/dockerfile"}}, nil
}

func (f *fakeResourceMgr) EnvFilePath() (string, bool) {
	if f.envFileOK || f.envFilePath != "" {
		return f.envFilePath, true
	}
	return "", false
}

func (f *fakeResourceMgr) ComposeMissingEnvVars(_, _, _ string) []string {
	return nil
}

func (f *fakeResourceMgr) CopyTemplatesDir(_ string) ([]string, error) {
	if f.copyTemplatesErr != nil {
		return nil, f.copyTemplatesErr
	}
	return f.copyTemplates, nil
}

func (f *fakeResourceMgr) CopyFile(_, _ string) error { return nil }

type fakeCommandRunner struct {
	err           error
	silentOut     string
	silentOutputs []string
	silentErr     error
	silentErrors  []error
	lastCmd       string
	lastArgs      []string
	lastEnv       []string
	lastDir       string
	commands      []recordedCommand
}

type recordedCommand struct {
	command string
	args    []string
	envVars []string
	dir     string
}

func (f *fakeCommandRunner) RunCommandWithLogging(_, command string, args []string, envVars []string, workingDir string) (error, string) {
	f.lastCmd = command
	f.lastArgs = args
	f.lastEnv = envVars
	f.lastDir = workingDir
	f.commands = append(f.commands, recordedCommand{command: command, args: append([]string(nil), args...), envVars: append([]string(nil), envVars...), dir: workingDir})
	return f.err, ""
}

func (f *fakeCommandRunner) RunCommandWithLoggingToFile(appIdent, command string, args []string, envVars []string, workingDir string, _ string) (error, string) {
	return f.RunCommandWithLogging(appIdent, command, args, envVars, workingDir)
}

func (f *fakeCommandRunner) RunCommandSilent(command string, args []string, envVars []string, workingDir string) (error, string) {
	f.lastCmd = command
	f.lastArgs = args
	f.lastEnv = envVars
	f.lastDir = workingDir
	f.commands = append(f.commands, recordedCommand{command: command, args: append([]string(nil), args...), envVars: append([]string(nil), envVars...), dir: workingDir})
	if len(f.silentErrors) > 0 {
		err := f.silentErrors[0]
		f.silentErrors = f.silentErrors[1:]
		if err != nil {
			return err, ""
		}
	}
	if f.silentErr != nil {
		return f.silentErr, ""
	}
	if len(f.silentOutputs) > 0 {
		output := f.silentOutputs[0]
		f.silentOutputs = f.silentOutputs[1:]
		return nil, output
	}
	return nil, f.silentOut
}

func newServiceWithFakeResources(fake *fakeResourceMgr) *service {
	return &service{resourceMgr: fake, executor: &fakeCommandRunner{silentOut: `{}`}}
}

func TestDiscoverKubernetesRunStatusPrefersRunningTarget(t *testing.T) {
	resources := &fakeResourceMgr{targets: []resources.ActionTarget{
		{ID: "k8s-failed", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeKubernetes, Kubernetes: &resources.KubernetesTargetMetadata{Namespace: "apps", Release: "failed"}},
		{ID: "k8s-running", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeKubernetes, Kubernetes: &resources.KubernetesTargetMetadata{Namespace: "apps", Release: "running"}},
	}}
	runner := &fakeCommandRunner{silentOutputs: []string{
		"failed-pod 0/1 Error 0 1m\n",
		"running-pod 1/1 Running 0 1m\n",
	}}
	svc := &service{resourceMgr: resources, executor: runner}
	if got := svc.DiscoverKubernetesRunStatus("api", "/repo"); got != "running (1/1 pods)" {
		t.Fatalf("status=%q", got)
	}
}

func TestKubernetesTargetStatusTreatsNoResourcesAsStopped(t *testing.T) {
	svc := &service{executor: &fakeCommandRunner{silentOut: "No resources found in apps namespace.\n"}}
	if got := svc.kubernetesTargetStatus(&resources.KubernetesTargetMetadata{Namespace: "apps", Release: "api"}); got != "stopped (0 pods)" {
		t.Fatalf("status=%q", got)
	}
}

func TestKubernetesTargetStatusUsesTargetContext(t *testing.T) {
	runner := &fakeCommandRunner{silentOut: "api 1/1 Running 0 1m\n"}
	svc := &service{executor: runner}
	if got := svc.kubernetesTargetStatus(&resources.KubernetesTargetMetadata{ContextName: "kind-podman", Namespace: "apps", Release: "api"}); got != "running (1/1 pods)" {
		t.Fatalf("status=%q", got)
	}
	if got := runner.commands[0].args[1]; got != "kind-podman" {
		t.Fatalf("context=%q", got)
	}
}

func TestExtractArtifactsCommandSequenceAndCleanupGolden(t *testing.T) {
	copyFailure := errors.New("copy failed")
	runner := &fakeCommandRunner{silentErrors: []error{nil, copyFailure, nil}}
	svc := &service{executor: runner}
	err := svc.extractArtifacts("api", t.TempDir(), "api-image", "dist/output", "")
	if err == nil || !strings.Contains(err.Error(), "failed to copy artifacts") {
		t.Fatalf("error = %v", err)
	}
	got := make([]string, 0, len(runner.commands))
	for _, command := range runner.commands {
		got = append(got, command.command+" "+strings.Join(command.args, " "))
	}
	want := []string{
		docker.RuntimeCommand() + " create --name api-extract api-image",
		docker.RuntimeCommand() + " cp api-extract:dist/output " + filepath.Join(filepath.Dir(runner.commands[1].args[1]), "output"),
		docker.RuntimeCommand() + " rm api-extract",
	}
	// Destination contains the test temp path; compare stable command shapes and exact cleanup order.
	if len(got) != 3 || got[0] != want[0] || !strings.HasPrefix(got[1], docker.RuntimeCommand()+" cp api-extract:dist/output ") || got[2] != want[2] {
		t.Fatalf("artifact command sequence changed:\n got: %v\nwant shapes: %v", got, want)
	}
}

func TestBuildAppCopyTemplates(t *testing.T) {
	hardErr := errors.New("disk error")

	tests := []struct {
		name             string
		copyTemplatesErr error
		wantErrSubstr    string
	}{
		{
			name: "templates dir missing — skipped silently (nil, nil)",
		},
		{
			name:             "templates dir hard error — fails build",
			copyTemplatesErr: hardErr,
			wantErrSubstr:    "disk error",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			appDir := t.TempDir()
			fake := &fakeResourceMgr{
				copyTemplatesErr: tt.copyTemplatesErr,
			}

			svc := newServiceWithFakeResources(fake)

			var got string
			svc.buildAppInternal(&app.App{
				Ident:              "test-app",
				LocalDirectoryPath: appDir,
			}, "", func(s string) { got = s })

			if tt.wantErrSubstr != "" {
				if !strings.Contains(got, tt.wantErrSubstr) {
					t.Fatalf("expected status containing %q, got %q", tt.wantErrSubstr, got)
				}
				return
			}

			if strings.HasPrefix(got, "Error:") {
				t.Fatalf("unexpected error status: %q", got)
			}
		})
	}
}

func TestPodmanCacheRepositoryRemovesTagOrDigest(t *testing.T) {
	tests := map[string]string{
		"bhvr-site:latest":                          "bhvr-site",
		"localhost/my-app:dev":                      "localhost/my-app",
		"registry.example.com/team/my-app:20260701": "registry.example.com/team/my-app",
		"registry.example.com:5000/team/my-app:v1":  "registry.example.com:5000/team/my-app",
		"bhvr-site@sha256:abc":                      "bhvr-site",
	}
	for in, want := range tests {
		if got := podmanCacheRepository(in); got != want {
			t.Fatalf("podmanCacheRepository(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBuildAppDockerUsesBuildKitAndCache(t *testing.T) {
	appDir := t.TempDir()
	runner := &fakeCommandRunner{silentOut: `{}`}
	svc := &service{resourceMgr: &fakeResourceMgr{}, executor: runner}

	var commands []recordedCommand
	svc.buildAppInternal(&app.App{
		Ident:              "test-app",
		LocalDirectoryPath: appDir,
	}, "", func(status string) {
		if status == "build successful" {
			commands = append(commands, runner.commands...)
		}
	})

	var buildCmd *recordedCommand
	for i := range commands {
		if len(commands[i].args) > 0 && commands[i].args[0] == "build" {
			buildCmd = &commands[i]
			break
		}
	}
	if buildCmd == nil {
		t.Fatalf("expected docker build command, got %#v", commands)
	}
	args := strings.Join(buildCmd.args, " ")
	if !strings.Contains(args, "--cache-from devenv-test-app:latest") {
		t.Fatalf("expected docker build cache-from args, got %#v", buildCmd.args)
	}
	if !strings.Contains(args, "--build-arg BUILDKIT_INLINE_CACHE=1") {
		t.Fatalf("expected inline cache build arg, got %#v", buildCmd.args)
	}
	if !strings.Contains(args, "--progress=plain") {
		t.Fatalf("expected plain progress, got %#v", buildCmd.args)
	}
	if strings.Join(buildCmd.envVars, " ") != "DOCKER_BUILDKIT=1" {
		t.Fatalf("expected BuildKit env, got %#v", buildCmd.envVars)
	}
}

func TestBuildAppCopiedFilesRemovedAfterBuild(t *testing.T) {
	appDir := t.TempDir()

	f1 := filepath.Join(appDir, ".npmrc")
	f2 := filepath.Join(appDir, "settings.xml")
	for _, p := range []string{f1, f2} {
		if err := os.WriteFile(p, []byte("data"), 0644); err != nil {
			t.Fatalf("failed to create fake template file: %v", err)
		}
	}

	fake := &fakeResourceMgr{
		copyTemplates: []string{f1, f2},
	}
	svc := newServiceWithFakeResources(fake)

	svc.buildAppInternal(&app.App{
		Ident:              "test-app",
		LocalDirectoryPath: appDir,
	}, "", func(string) {})

	for _, p := range []string{f1, f2} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("expected %q to be removed after build, but it still exists", p)
		}
	}
}

func TestBuildAppDockerfileError(t *testing.T) {
	appDir := t.TempDir()
	fake := &fakeResourceMgr{
		dockerfileErr: errors.New("no dockerfile"),
	}

	svc := newServiceWithFakeResources(fake)

	var got string
	svc.buildAppInternal(&app.App{
		Ident:              "test-app",
		LocalDirectoryPath: appDir,
	}, "", func(s string) { got = s })

	if !strings.Contains(got, "no dockerfile") {
		t.Fatalf("expected dockerfile error, got %q", got)
	}
}

func TestTestAppCheckoutNeeded(t *testing.T) {
	svc := newServiceWithFakeResources(&fakeResourceMgr{})

	var got string
	svc.testAppInternal(&app.App{
		Ident:              "test-app",
		LocalDirectoryPath: "/nonexistent/path",
	}, "", func(s string) { got = s })

	if !strings.Contains(got, "Checkout needed") {
		t.Fatalf("expected 'Checkout needed', got %q", got)
	}
}

func TestRunAppCheckoutNeeded(t *testing.T) {
	svc := newServiceWithFakeResources(&fakeResourceMgr{})

	var got string
	svc.runAppInternal(&app.App{
		Ident:              "test-app",
		LocalDirectoryPath: "/nonexistent/path",
	}, "", "", func(s string) { got = s })

	if !strings.Contains(got, "Checkout needed") {
		t.Fatalf("expected 'Checkout needed', got %q", got)
	}
}

func TestRunAppComposeFileError(t *testing.T) {
	appDir := t.TempDir()
	fake := &fakeResourceMgr{
		composeErr: errors.New("no compose file"),
	}

	svc := newServiceWithFakeResources(fake)

	var got string
	svc.runAppInternal(&app.App{
		Ident:              "test-app",
		LocalDirectoryPath: appDir,
	}, "", "", func(s string) { got = s })

	if !strings.Contains(got, "no compose file") {
		t.Fatalf("expected compose error, got %q", got)
	}
}

func TestShellBuildTargetRunsWithLoggingFromAppDir(t *testing.T) {
	appDir := t.TempDir()
	fake := &fakeResourceMgr{targets: []resources.ActionTarget{{
		ID:         "build:shell",
		Action:     resources.AppActionBuild,
		Runtime:    resources.ActionRuntimeShell,
		Label:      "Shell",
		LaunchMode: resources.LaunchModeLogged,
		SourcePath: "/config/apps/build/test-app-build.sh",
	}}}
	runner := &fakeCommandRunner{}
	svc := &service{resourceMgr: fake, executor: runner}

	var got string
	svc.buildAppInternal(&app.App{Ident: "test-app", LocalDirectoryPath: appDir}, "build:shell", func(s string) { got = s })

	if got != "build successful" {
		t.Fatalf("status = %q, want build successful", got)
	}
	if runner.lastCmd != "sh" || runner.lastArgs[0] != "/config/apps/build/test-app-build.sh" || runner.lastDir != appDir {
		t.Fatalf("unexpected shell command: cmd=%q args=%v dir=%q", runner.lastCmd, runner.lastArgs, runner.lastDir)
	}
}

func TestMissingScriptShellReportsClearError(t *testing.T) {
	appDir := t.TempDir()
	fake := &fakeResourceMgr{targets: []resources.ActionTarget{{
		ID:         "build:powershell",
		Action:     resources.AppActionBuild,
		Runtime:    resources.ActionRuntimePowerShell,
		Label:      "PowerShell",
		LaunchMode: resources.LaunchModeLogged,
		SourcePath: filepath.Join(appDir, "test-app-build.ps1"),
		Command:    "devenv-missing-powershell-for-test",
		Args:       []string{"-File", filepath.Join(appDir, "test-app-build.ps1")},
	}}}
	runner := &fakeCommandRunner{}
	svc := &service{resourceMgr: fake, executor: runner}

	var got string
	svc.buildAppInternal(&app.App{Ident: "test-app", LocalDirectoryPath: appDir}, "build:powershell", func(s string) { got = s })

	if got != "Error: required tool not found: devenv-missing-powershell-for-test" {
		t.Fatalf("status = %q", got)
	}
	if runner.lastCmd != "" {
		t.Fatalf("command runner should not be called, got %q", runner.lastCmd)
	}
}

func TestMissingRootBuildToolReportsClearError(t *testing.T) {
	appDir := t.TempDir()
	fake := &fakeResourceMgr{targets: []resources.ActionTarget{{
		ID:         "build:shell:missing",
		Action:     resources.AppActionBuild,
		Runtime:    resources.ActionRuntimeShell,
		Label:      "Missing build",
		LaunchMode: resources.LaunchModeLogged,
		SourcePath: filepath.Join(appDir, "Makefile"),
		Command:    "devenv-missing-build-tool-for-test",
		Args:       []string{"build"},
	}}}
	runner := &fakeCommandRunner{}
	svc := &service{resourceMgr: fake, executor: runner}

	var got string
	svc.buildAppInternal(&app.App{Ident: "test-app", LocalDirectoryPath: appDir}, "build:shell:missing", func(s string) { got = s })

	if got != "Error: required tool not found: devenv-missing-build-tool-for-test" {
		t.Fatalf("status = %q", got)
	}
	if runner.lastCmd != "" {
		t.Fatalf("command runner should not be called, got %q", runner.lastCmd)
	}
}

func TestRootBuildToolTargetRunsCommandFromAppDir(t *testing.T) {
	appDir := t.TempDir()
	toolPath := filepath.Join(appDir, "devenv-tool")
	if err := os.WriteFile(toolPath, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
	fake := &fakeResourceMgr{targets: []resources.ActionTarget{{
		ID:         "build:shell:make",
		Action:     resources.AppActionBuild,
		Runtime:    resources.ActionRuntimeShell,
		Label:      "Make build",
		LaunchMode: resources.LaunchModeLogged,
		SourcePath: filepath.Join(appDir, "Makefile"),
		Command:    "./devenv-tool",
		Args:       []string{"build"},
	}}}
	runner := &fakeCommandRunner{}
	svc := &service{resourceMgr: fake, executor: runner}

	var got string
	svc.buildAppInternal(&app.App{Ident: "test-app", LocalDirectoryPath: appDir}, "build:shell:make", func(s string) { got = s })

	if got != "build successful" {
		t.Fatalf("status = %q, want build successful", got)
	}
	if runner.lastCmd != "./devenv-tool" || len(runner.lastArgs) != 1 || runner.lastArgs[0] != "build" || runner.lastDir != appDir {
		t.Fatalf("unexpected root tool command: cmd=%q args=%v dir=%q", runner.lastCmd, runner.lastArgs, runner.lastDir)
	}
}

func TestShellTmuxRunFallsBackToLoggedWithoutTmux(t *testing.T) {
	t.Setenv("TMUX", "")
	appDir := t.TempDir()
	fake := &fakeResourceMgr{targets: []resources.ActionTarget{{
		ID:         "run:shell:dev",
		Action:     resources.AppActionRun,
		Runtime:    resources.ActionRuntimeShell,
		Profile:    "dev",
		LaunchMode: resources.LaunchModeTmux,
		SourcePath: "/config/apps/run/test-app-dev.sh",
	}}}
	runner := &fakeCommandRunner{}
	svc := &service{resourceMgr: fake, executor: runner}

	var statuses []string
	svc.runAppInternal(&app.App{Ident: "test-app", LocalDirectoryPath: appDir}, "", "run:shell:dev", func(s string) { statuses = append(statuses, s) })

	if len(statuses) < 2 || statuses[0] != "tmux unavailable; running logged" || statuses[len(statuses)-1] != "run successful" {
		t.Fatalf("statuses = %#v, want logged fallback then success", statuses)
	}
	if runner.lastCmd != "sh" || runner.lastArgs[0] != "/config/apps/run/test-app-dev.sh" || runner.lastDir != appDir {
		t.Fatalf("unexpected fallback command: cmd=%q args=%v dir=%q", runner.lastCmd, runner.lastArgs, runner.lastDir)
	}
}

func TestShellTmuxRunStoresWindowAndStopKillsIt(t *testing.T) {
	t.Setenv("TMUX", "/tmp/tmux-1/default,1,0")
	appDir := t.TempDir()
	fake := &fakeResourceMgr{targets: []resources.ActionTarget{{
		ID:         "run:shell:dev",
		Action:     resources.AppActionRun,
		Runtime:    resources.ActionRuntimeShell,
		Profile:    "dev",
		LaunchMode: resources.LaunchModeTmux,
		SourcePath: "/config/apps/run/test-app-dev.sh",
	}}}
	runner := &fakeCommandRunner{silentOut: "%7\n"}
	svc := &service{resourceMgr: fake, executor: runner, tmuxRuns: make(map[string]ShellTmuxRunState)}

	var got string
	svc.runAppInternal(&app.App{Ident: "test-app", LocalDirectoryPath: appDir}, "", "run:shell:dev", func(s string) { got = s })
	if got != "run successful" {
		t.Fatalf("status = %q, want run successful", got)
	}
	if svc.tmuxRuns["test-app"].WindowID != "%7" {
		t.Fatalf("stored state = %#v", svc.tmuxRuns["test-app"])
	}
	if err := svc.StopShellTmuxRun("test-app"); err != nil {
		t.Fatalf("StopShellTmuxRun error = %v", err)
	}
	if runner.lastCmd != "tmux" || len(runner.lastArgs) < 3 || runner.lastArgs[0] != "kill-window" || runner.lastArgs[2] != "%7" {
		t.Fatalf("unexpected stop command: %s %v", runner.lastCmd, runner.lastArgs)
	}
}

type fakeAppRegistry struct {
	apps  []app.App
	infra []app.InfraService
}

func (f fakeAppRegistry) GetApps() []app.App                   { return f.apps }
func (f fakeAppRegistry) GetInfraServices() []app.InfraService { return f.infra }
func (f fakeAppRegistry) GetAppByIdent(ident string) (app.App, bool) {
	for _, a := range f.apps {
		if a.Ident == ident {
			return a, true
		}
	}
	return app.App{}, false
}

type fakeInfraStarter struct {
	started []string
	err     error
}

func (f *fakeInfraStarter) StartInfrastructureServiceWithStatus(infra app.InfraService) {
	f.started = append(f.started, infra.Ident)
}
func (f *fakeInfraStarter) StartScriptInfrastructureServiceWithStatus(infra app.InfraService, _ string) error {
	f.started = append(f.started, infra.Ident)
	return f.err
}
func (f *fakeInfraStarter) StartKubernetesInfrastructureServiceWithStatus(infra app.InfraService) error {
	f.started = append(f.started, infra.Ident)
	return f.err
}
func (f *fakeInfraStarter) StartKubernetesInfrastructureServiceWithLog(infra app.InfraService, _ string) error {
	f.started = append(f.started, infra.Ident)
	return f.err
}

func TestResolveRunActionStepsDeduplicatesSharedDependencies(t *testing.T) {
	appDir := t.TempDir()
	frontendID := resources.AppRunTargetID("frontend", resources.ActionRuntimeShell, "dev")
	backendID := resources.AppRunTargetID("backend", resources.ActionRuntimeShell, "dev")
	fake := &fakeResourceMgr{targets: []resources.ActionTarget{
		{ID: frontendID, Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, Profile: "dev", SourcePath: "/frontend.sh", Requires: []resources.DependencyRef{{App: "backend", Runtime: string(resources.ActionRuntimeShell), Profile: "dev"}, {Infra: "postgres"}}},
		{ID: backendID, Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, Profile: "dev", SourcePath: "/backend.sh", Requires: []resources.DependencyRef{{Infra: "postgres"}}},
	}}
	svc := &service{resourceMgr: fake, appRegistry: fakeAppRegistry{apps: []app.App{{Ident: "frontend", LocalDirectoryPath: appDir}, {Ident: "backend", LocalDirectoryPath: appDir}}, infra: []app.InfraService{{Ident: "postgres"}}}}
	steps, err := svc.ResolveRunActionSteps(&app.App{Ident: "frontend", LocalDirectoryPath: appDir}, frontendID, "")
	if err != nil {
		t.Fatal(err)
	}
	postgresID := resources.InfraTargetID("postgres")
	count := 0
	for _, step := range steps {
		if step.ID == postgresID {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("postgres steps = %d, steps=%#v", count, steps)
	}
}

func TestRunDependenciesDoNotProbeScriptInfrastructureAsContainer(t *testing.T) {
	appDir := t.TempDir()
	targetID := resources.AppRunTargetID("frontend", resources.ActionRuntimeShell, "dev")
	fake := &fakeResourceMgr{targets: []resources.ActionTarget{{
		ID: targetID, Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, Profile: "dev", SourcePath: "/frontend.sh", Requires: []resources.DependencyRef{{Infra: "script-clock"}},
	}}}
	waiter := &countingHealthWaiter{}
	infra := &fakeInfraStarter{}
	svc := &service{
		resourceMgr: fake, appRegistry: fakeAppRegistry{apps: []app.App{{Ident: "frontend", LocalDirectoryPath: appDir}}, infra: []app.InfraService{{Ident: "script-clock", Type: app.InfraServiceTypeScript}}},
		infraStarter: infra, healthWaiter: waiter,
	}
	if err := svc.startRunDependencies(resources.ActionTarget{ID: targetID}, "", func(string) {}); err != nil {
		t.Fatal(err)
	}
	if len(infra.started) != 1 || infra.started[0] != "script-clock" {
		t.Fatalf("started infra = %#v", infra.started)
	}
	if waiter.calls != 0 {
		t.Fatalf("script infrastructure probed container readiness %d times", waiter.calls)
	}
}

func TestRunAppStartsDependenciesBeforeRequestedTarget(t *testing.T) {
	t.Setenv("TMUX", "")
	frontendDir := t.TempDir()
	backendDir := t.TempDir()
	frontendID := resources.AppRunTargetID("frontend", resources.ActionRuntimeShell, "dev")
	backendID := resources.AppRunTargetID("backend", resources.ActionRuntimeShell, "dev")
	fake := &fakeResourceMgr{targets: []resources.ActionTarget{
		{ID: frontendID, Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, Profile: "dev", LaunchMode: resources.LaunchModeTmux, SourcePath: "/config/apps/run/frontend-dev.sh", Requires: []resources.DependencyRef{{App: "backend", Runtime: string(resources.ActionRuntimeShell), Profile: "dev"}, {Infra: "postgres"}}},
		{ID: backendID, Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, Profile: "dev", LaunchMode: resources.LaunchModeTmux, SourcePath: "/config/apps/run/backend-dev.sh"},
	}}
	runner := &fakeCommandRunner{}
	infra := &fakeInfraStarter{}
	svc := &service{resourceMgr: fake, executor: runner, tmuxRuns: map[string]ShellTmuxRunState{}, appRegistry: fakeAppRegistry{apps: []app.App{{Ident: "frontend", LocalDirectoryPath: frontendDir}, {Ident: "backend", LocalDirectoryPath: backendDir}}, infra: []app.InfraService{{Ident: "postgres"}}}, infraStarter: infra}

	var statuses []string
	svc.runAppInternal(&app.App{Ident: "frontend", LocalDirectoryPath: frontendDir}, "", frontendID, func(s string) { statuses = append(statuses, s) })
	joined := strings.Join(statuses, "\n")
	if !strings.Contains(joined, "starting dependency "+resources.InfraTargetID("postgres")) || !strings.Contains(joined, "starting dependency "+backendID) {
		t.Fatalf("statuses = %#v", statuses)
	}
	if len(infra.started) != 1 || infra.started[0] != "postgres" {
		t.Fatalf("started infra = %#v", infra.started)
	}
	if runner.lastArgs[0] != "/config/apps/run/frontend-dev.sh" || runner.lastDir != frontendDir {
		t.Fatalf("last run = %s %v dir=%s", runner.lastCmd, runner.lastArgs, runner.lastDir)
	}
}

func TestRunAppDependencyCyclePreventsStart(t *testing.T) {
	appDir := t.TempDir()
	aID := resources.AppRunTargetID("a", resources.ActionRuntimeShell, "dev")
	bID := resources.AppRunTargetID("b", resources.ActionRuntimeShell, "dev")
	fake := &fakeResourceMgr{targets: []resources.ActionTarget{
		{ID: aID, Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, Profile: "dev", LaunchMode: resources.LaunchModeTmux, SourcePath: "/a.sh", Requires: []resources.DependencyRef{{App: "b", Runtime: string(resources.ActionRuntimeShell), Profile: "dev"}}},
		{ID: bID, Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, Profile: "dev", LaunchMode: resources.LaunchModeTmux, SourcePath: "/b.sh", Requires: []resources.DependencyRef{{App: "a", Runtime: string(resources.ActionRuntimeShell), Profile: "dev"}}},
	}}
	runner := &fakeCommandRunner{}
	svc := &service{resourceMgr: fake, executor: runner, tmuxRuns: map[string]ShellTmuxRunState{}, appRegistry: fakeAppRegistry{apps: []app.App{{Ident: "a", LocalDirectoryPath: appDir}, {Ident: "b", LocalDirectoryPath: appDir}}}, infraStarter: &fakeInfraStarter{}}

	var got string
	svc.runAppInternal(&app.App{Ident: "a", LocalDirectoryPath: appDir}, "", aID, func(s string) { got = s })
	if !strings.Contains(got, "dependency cycle") {
		t.Fatalf("status = %q", got)
	}
	if runner.lastCmd != "" {
		t.Fatalf("runner called despite cycle: %s", runner.lastCmd)
	}
}
