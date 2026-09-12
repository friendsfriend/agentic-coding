package operations

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/logging"
	"github.com/friendsfriend/devenv/pkg/resources"
	"github.com/friendsfriend/devenv/pkg/status"
)

func newScriptTestService(t *testing.T, configDir string) *service {
	t.Helper()
	logger, err := logging.NewLogger(t.TempDir())
	if err != nil {
		t.Fatalf("NewLogger: %v", err)
	}
	return NewService(nil, NewExecutor(logger), status.NewManager(), resources.NewManager(configDir), "").(*service)
}

func writeScript(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0755); err != nil {
		t.Fatalf("write script: %v", err)
	}
	return path
}

func TestExpandScriptInfraConfigPaths(t *testing.T) {
	infra := expandScriptInfraConfigPaths(app.InfraService{
		Cwd: "$CONFIG", ShellPath: "$CONFIG/scripts/clock.sh", PowerShellPath: "${CONFIG}/scripts/clock.ps1", Args: []string{"--config=$CONFIG/config.json"},
	}, "/tmp/devenv")
	if infra.Cwd != "/tmp/devenv" || infra.ShellPath != "/tmp/devenv/scripts/clock.sh" || infra.PowerShellPath != "/tmp/devenv/scripts/clock.ps1" || infra.Args[0] != "--config=/tmp/devenv/config.json" {
		t.Fatalf("expanded infra = %#v", infra)
	}
}

func TestActionOutputWriterForwardsProcessStreams(t *testing.T) {
	var got string
	writer := actionOutputWriter{stream: "stderr", output: func(stream, chunk string) { got = stream + ":" + chunk }}
	if _, err := writer.Write([]byte("script output")); err != nil {
		t.Fatal(err)
	}
	if got != "stderr:script output" {
		t.Fatalf("output = %q", got)
	}
}

func TestResolveScriptRunner(t *testing.T) {
	shellScript := "svc.sh"
	psScript := "svc.ps1"

	runner, command, args, err := resolveScriptRunner(app.InfraService{Ident: "svc", ShellPath: shellScript}, "")
	if err != nil {
		t.Fatalf("shell resolve failed: %v", err)
	}
	if runner != app.ScriptRunnerShell || command == "" || len(args) != 1 || args[0] != shellScript {
		t.Fatalf("unexpected shell resolve: runner=%q command=%q args=%v", runner, command, args)
	}

	runner, _, args, err = resolveScriptRunner(app.InfraService{Ident: "svc", PowerShellPath: psScript}, app.ScriptRunnerPowerShell)
	if err != nil && runner != "" {
		t.Fatalf("expected missing PowerShell error or valid runner, got runner=%q err=%v", runner, err)
	}
	if err == nil && (runner != app.ScriptRunnerPowerShell || args[0] != "-File" || args[1] != psScript) {
		t.Fatalf("unexpected powershell resolve: runner=%q args=%v", runner, args)
	}

	_, _, _, err = resolveScriptRunner(app.InfraService{Ident: "svc", ShellPath: shellScript, PowerShellPath: psScript}, "")
	if err == nil {
		t.Fatal("expected runner selection required")
	}
}

func TestScriptServiceStartDuplicateStopAndExit(t *testing.T) {
	configDir := t.TempDir()
	workDir := t.TempDir()
	script := writeScript(t, workDir, "svc.sh", "#!/bin/sh\necho started\nsleep 5\n")
	svc := app.InfraService{Ident: "svc", Type: app.InfraServiceTypeScript, ShellPath: script, Cwd: workDir}
	ops := newScriptTestService(t, configDir)
	t.Setenv("TMUX", "")

	if err := ops.StartScriptInfrastructureServiceWithStatus(svc, ""); err != nil {
		t.Fatalf("start: %v", err)
	}
	if status, _ := ops.ScriptInfrastructureStatus("svc"); status != app.InfraStatusRunning {
		t.Fatalf("status after start = %q", status)
	}
	if err := ops.StartScriptInfrastructureServiceWithStatus(svc, ""); err != nil {
		t.Fatalf("duplicate start: %v", err)
	}
	if len(ops.scriptRuns) != 1 {
		t.Fatalf("duplicate start created %d runs", len(ops.scriptRuns))
	}
	if err := ops.StopScriptInfrastructureServiceWithStatus("svc"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if status, _ := ops.ScriptInfrastructureStatus("svc"); status != app.InfraStatusStopped {
		t.Fatalf("status after stop = %q", status)
	}
}

func TestScriptServiceFailedExit(t *testing.T) {
	configDir := t.TempDir()
	workDir := t.TempDir()
	script := writeScript(t, workDir, "fail.sh", "#!/bin/sh\necho fail\nexit 7\n")
	svc := app.InfraService{Ident: "fail", Type: app.InfraServiceTypeScript, ShellPath: script, Cwd: workDir}
	ops := newScriptTestService(t, configDir)
	t.Setenv("TMUX", "")

	if err := ops.StartScriptInfrastructureServiceWithStatus(svc, ""); err != nil {
		t.Fatalf("start: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		status, logPath := ops.ScriptInfrastructureStatus("fail")
		if status == app.InfraStatusFailed {
			if _, err := os.Stat(logPath); err != nil {
				t.Fatalf("expected log file: %v", err)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("service did not reach failed status")
}
