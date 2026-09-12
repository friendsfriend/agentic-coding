package operations

import (
	"testing"

	"github.com/friendsfriend/devenv/pkg/logging"
)

func TestActionScopedSilentCommandsEmitOneLifecycleEach(t *testing.T) {
	logger, err := logging.NewLogger(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	executor := NewExecutor(logger)
	var starts, dones []string
	executor.ConfigureActionForApp("app", func(string, string, string) {}, func(step, command string, args []string) {
		starts = append(starts, step+":"+command)
	}, func(step string, err error) {
		dones = append(dones, step)
	})
	executor.SetActionStepForApp("app", "parent")
	for _, text := range []string{"one", "two"} {
		if err, _ := executor.RunCommandSilentForAction("app", "printf", []string{text}, nil, ""); err != nil {
			t.Fatal(err)
		}
	}
	if len(starts) != 2 || len(dones) != 2 {
		t.Fatalf("starts=%v dones=%v", starts, dones)
	}
}

func TestConfigureActionForAppPreservesPreviouslyBoundStep(t *testing.T) {
	logger, err := logging.NewLogger(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	executor := NewExecutor(logger)
	executor.SetActionStepForApp("script-clock", "infra:script-clock")
	executor.ConfigureActionForApp("script-clock", func(string, string, string) {}, func(string, string, []string) {}, func(string, error) {})
	stepID, _, _, _, configured := executor.ActionCallbacksForApp("script-clock")
	if !configured || stepID != "infra:script-clock" {
		t.Fatalf("configured=%v step=%q", configured, stepID)
	}
}

func TestActionCallbacksForAppExposeBoundDependencyContext(t *testing.T) {
	logger, err := logging.NewLogger(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	executor := NewExecutor(logger)
	started, done := 0, 0
	executor.ConfigureActionForApp("dependency", func(string, string, string) {}, func(string, string, []string) { started++ }, func(string, error) { done++ })
	executor.SetActionStepForApp("dependency", "dependency:script")
	stepID, _, command, complete, configured := executor.ActionCallbacksForApp("dependency")
	if stepID != "dependency:script" || command == nil || complete == nil || !configured {
		t.Fatalf("callbacks = step=%q command=%v done=%v configured=%v", stepID, command != nil, complete != nil, configured)
	}
	command(stepID, "sh", []string{"script.sh"})
	complete(stepID, nil)
	if started != 1 || done != 1 {
		t.Fatalf("started=%d done=%d", started, done)
	}
}

func TestDetailedCommandSeparatesStdoutAndStderr(t *testing.T) {
	logger, err := logging.NewLogger(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	err, stdout, stderr := NewExecutor(logger).RunCommandDetailed("task", "sh", []string{"-c", "printf out; printf err >&2"}, nil, "")
	if err != nil || stdout != "out" || stderr != "err" {
		t.Fatalf("err=%v stdout=%q stderr=%q", err, stdout, stderr)
	}
}
