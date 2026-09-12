package server

import (
	"testing"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/build"
	"github.com/friendsfriend/devenv/pkg/docker"
	"github.com/friendsfriend/devenv/pkg/resources"
	"github.com/friendsfriend/devenv/pkg/runstatus"
)

func TestAppStatusEventPropertiesRunTargetInfoOptional(t *testing.T) {
	buildSvc := build.NewService(nil, nil, nil, "")
	buildSvc.SetRunTargetInfo("app", resources.ActionTarget{ID: "target", Runtime: resources.ActionRuntimeShell, LaunchMode: resources.LaunchModeTmux, Label: "bun build", Profile: "default", SourcePath: "/repo/package.json"})
	withInfo := &Server{services: &stubServicesContainer{buildService: buildSvc}}
	runtimeStatus := runstatus.Normalize("running")
	props := withInfo.appStatusEventProperties(app.App{Ident: "app", AppType: app.TypeAPP}, &docker.Info{}, "✓", "main", nil, &runtimeStatus)
	info, ok := props["runTargetInfo"].(*build.RunTargetInfo)
	if !ok || info.Display != "[tmux] bun build (default)" {
		t.Fatalf("runTargetInfo = %#v", props["runTargetInfo"])
	}

	withoutInfo := &Server{services: &stubServicesContainer{buildService: build.NewService(nil, nil, nil, "")}}
	props = withoutInfo.appStatusEventProperties(app.App{Ident: "app", AppType: app.TypeAPP}, &docker.Info{}, "✓", "main", nil, &runtimeStatus)
	if value, ok := props["runTargetInfo"]; !ok || value != nil {
		t.Fatalf("runTargetInfo should clear when absent: %#v", value)
	}
}
