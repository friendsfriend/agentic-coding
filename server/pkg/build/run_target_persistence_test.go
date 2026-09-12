package build

import (
	"testing"

	"github.com/friendsfriend/devenv/pkg/resources"
	"github.com/friendsfriend/devenv/pkg/state"
)

func TestRunTargetInfoPersistsToStateStore(t *testing.T) {
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	defer store.Close()

	svc := NewService(nil, nil, nil, "")
	svc.ConfigureStateStore(store)
	target := resources.ActionTarget{ID: "app/app/run/shell/default", Runtime: resources.ActionRuntimeShell, LaunchMode: resources.LaunchModeTmux, Label: "bun build", Profile: "default", SourcePath: "/repo/package.json"}
	svc.SetRunTargetInfo("app", target)

	reloaded := NewService(nil, nil, nil, "")
	reloaded.ConfigureStateStore(store)
	info, ok := reloaded.RunTargetInfo("app")
	if !ok {
		t.Fatal("expected persisted run target info")
	}
	if info.Display != "[tmux] bun build (default)" || info.TargetID != target.ID || info.SourcePath != target.SourcePath {
		t.Fatalf("persisted info = %#v", info)
	}

	reloaded.ClearRunTargetInfo("app")
	cleared := NewService(nil, nil, nil, "")
	cleared.ConfigureStateStore(store)
	if _, ok := cleared.RunTargetInfo("app"); ok {
		t.Fatal("expected run target info cleared from state store")
	}
}
