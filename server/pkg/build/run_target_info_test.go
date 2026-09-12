package build

import (
	"testing"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/resources"
)

func TestFormatRunTargetDisplay(t *testing.T) {
	tests := []struct {
		name   string
		target resources.ActionTarget
		want   string
	}{
		{"tmux shell", resources.ActionTarget{Runtime: resources.ActionRuntimeShell, LaunchMode: resources.LaunchModeTmux, Label: "bun build", Profile: "default"}, "[tmux] bun build (default)"},
		{"docker default", resources.ActionTarget{Runtime: resources.ActionRuntimeDocker, Label: "default"}, "[docker] default (default)"},
		{"podman compose", resources.ActionTarget{Runtime: resources.ActionRuntimeDocker, Provider: resources.ContainerProviderPodman, Label: "default"}, "[podman] default (default)"},
		{"powershell", resources.ActionTarget{Runtime: resources.ActionRuntimePowerShell, Label: "dev", Profile: "local"}, "[powershell] dev (local)"},
		{"systemshell", resources.ActionTarget{Runtime: resources.ActionRuntimeSystemShell, Label: "dev", Profile: "sys"}, "[systemshell] dev (sys)"},
		{"kubernetes", resources.ActionTarget{Runtime: resources.ActionRuntimeKubernetes, Label: "chart", Profile: "kind"}, "[kubernetes] chart (kind)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := FormatRunTargetDisplay(tt.target); got != tt.want {
				t.Fatalf("FormatRunTargetDisplay() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRunTargetInfoUsesContainerProviderRuntime(t *testing.T) {
	svc := &service{runTargetInfo: map[string]RunTargetInfo{}}
	svc.SetRunTargetInfo("api", resources.ActionTarget{ID: "app/api/run/podman/default", Runtime: resources.ActionRuntimeDocker, Provider: resources.ContainerProviderPodman, Label: "default"})
	info, ok := svc.RunTargetInfo("api")
	if !ok || info.Runtime != "podman" || info.Display != "[podman] default (default)" {
		t.Fatalf("run target info = %#v, ok %v", info, ok)
	}
}

func TestRunTargetInfoRecordedForResolvedAndLegacyProfile(t *testing.T) {
	appDir := t.TempDir()
	target := resources.ActionTarget{ID: "app/test/run/shell/dev", Action: resources.AppActionRun, Runtime: resources.ActionRuntimeShell, LaunchMode: resources.LaunchModeTmux, Label: "bun dev", Profile: "dev", SourcePath: appDir, Command: "echo"}
	svc := &service{resourceMgr: &fakeResourceMgr{targets: []resources.ActionTarget{target}}, executor: &fakeCommandRunner{}, runTargetInfo: map[string]RunTargetInfo{}, lastRunRuntime: map[string]resources.ActionRuntime{}}
	svc.runAppInternal(&app.App{Ident: "test", LocalDirectoryPath: appDir}, "", target.ID, func(string) {})
	info, ok := svc.RunTargetInfo("test")
	if !ok || info.Display != "[tmux] bun dev (dev)" || info.TargetID != target.ID {
		t.Fatalf("resolved run target info = %#v, ok %v", info, ok)
	}

	legacy := resources.ActionTarget{ID: resources.AppRunTargetID("legacy", resources.ActionRuntimeDocker, "default"), Action: resources.AppActionRun, Runtime: resources.ActionRuntimeDocker, Label: "default", SourcePath: appDir}
	svc = &service{resourceMgr: &fakeResourceMgr{targets: []resources.ActionTarget{legacy}}, executor: &fakeCommandRunner{}, runTargetInfo: map[string]RunTargetInfo{}, lastRunRuntime: map[string]resources.ActionRuntime{}}
	svc.runAppInternal(&app.App{Ident: "legacy", LocalDirectoryPath: appDir}, "default", "", func(string) {})
	info, ok = svc.RunTargetInfo("legacy")
	if !ok || info.Display != "[docker] default (default)" || info.TargetID != legacy.ID {
		t.Fatalf("legacy run target info = %#v, ok %v", info, ok)
	}
}
