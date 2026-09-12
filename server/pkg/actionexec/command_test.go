package actionexec

import (
	"context"
	"errors"
	"testing"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

type commandRunnerFunc func(context.Context, CommandSpec, func(string, string)) CommandResult

func (f commandRunnerFunc) Run(c context.Context, s CommandSpec, o func(string, string)) CommandResult {
	return f(c, s, o)
}

type commandEvents struct{ events []CommandEvent }

func (e *commandEvents) EmitCommand(event CommandEvent) { e.events = append(e.events, event) }

type commandContext struct{ ctx context.Context }

func (c commandContext) Context() context.Context         { return c.ctx }
func (commandContext) RunID() actiondef.RunID             { return "run" }
func (commandContext) StepID() actiondef.StepDefinitionID { return "step" }
func (commandContext) Require(actiondef.ValueKey) (actiondef.Value, error) {
	return actiondef.Value{}, errors.New("missing")
}
func (commandContext) Set(actiondef.ValueKey, actiondef.Value) error { return nil }
func (commandContext) Executor() actiondef.CommandExecutor           { return nil }
func (commandContext) Events() actiondef.EventSink                   { return nil }
func (commandContext) Secrets() actiondef.SecretResolver             { return nil }

func TestCommandHandlerRecordsStreamsExitAndRedactedDisplayArgs(t *testing.T) {
	events := &commandEvents{}
	runner := commandRunnerFunc(func(_ context.Context, s CommandSpec, out func(string, string)) CommandResult {
		if s.Args[1] != "secret" {
			t.Fatalf("execution args=%v", s.Args)
		}
		out("stdout", "ok")
		out("stderr", "warning")
		return CommandResult{Stdout: "ok", Stderr: "warning", ExitCode: 7, Err: errors.New("failed")}
	})
	h := CommandHandler{Runner: runner, Events: events}
	step := actiondef.Step{StepID: "step", StepType: actiondef.StepKindCommand, Configuration: map[string]any{"command": "tool", "args": []string{"--token", "secret"}, "displayArgs": []string{"--token", "[REDACTED]"}}}
	result := h.Execute(commandContext{context.Background()}, step)
	if result.Err == nil || result.ExitCode == nil || *result.ExitCode != 7 {
		t.Fatalf("result=%#v", result)
	}
	if len(events.events) != 4 || events.events[0].Args[1] != "[REDACTED]" || events.events[3].Type != "command.failed" {
		t.Fatalf("events=%#v", events.events)
	}
}

func TestCommandHandlerExtractsArtifactLabel(t *testing.T) {
	store := newValueStore(nil)
	ctx := &stepContext{ctx: context.Background(), runID: "run", stepID: "inspect", values: store}
	handler := CommandHandler{Runner: commandRunnerFunc(func(context.Context, CommandSpec, func(string, string)) CommandResult {
		return CommandResult{Stdout: `{"devenv.artifacts":"dist/output"}`}
	})}
	step := actiondef.Step{StepID: "inspect", StepType: actiondef.StepKindCommand, Configuration: map[string]any{"command": "docker", "args": []string{"inspect"}, "captureJSONLabel": "devenv.artifacts", "captureKey": "artifact.path"}}
	if result := handler.Execute(ctx, step); result.Err != nil {
		t.Fatal(result.Err)
	}
	value, ok := store.get("artifact.path")
	if !ok || value.Data != "dist/output" {
		t.Fatalf("value=%#v ok=%v", value, ok)
	}
}

func TestCommandHandlerCapturesAndConsumesNamedValues(t *testing.T) {
	store := newValueStore(nil)
	ctx := &stepContext{ctx: context.Background(), runID: "run", stepID: "get-ref", values: store}
	runner := commandRunnerFunc(func(_ context.Context, spec CommandSpec, _ func(string, string)) CommandResult {
		if spec.Args[0] == "rev-parse" {
			return CommandResult{Stdout: "main\n"}
		}
		if spec.Args[2] != "origin/main" {
			t.Fatalf("resolved args = %v", spec.Args)
		}
		return CommandResult{}
	})
	handler := CommandHandler{Runner: runner}
	first := actiondef.Step{StepID: "get-ref", StepType: actiondef.StepKindCommand, Configuration: map[string]any{"command": "git", "args": []string{"rev-parse"}, "captureStdout": "git.branch"}}
	if result := handler.Execute(ctx, first); result.Err != nil {
		t.Fatal(result.Err)
	}
	second := actiondef.Step{StepID: "pull", StepType: actiondef.StepKindCommand, Configuration: map[string]any{"command": "git", "args": []string{"reset", "--hard", "origin/${git.branch}"}}}
	if result := handler.Execute(ctx, second); result.Err != nil {
		t.Fatal(result.Err)
	}
}

func TestOSCommandRunnerCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := OSCommandRunner{}.Run(ctx, CommandSpec{Name: "sh", Args: []string{"-c", "sleep 10"}}, nil)
	if result.Err == nil {
		t.Fatal("expected cancellation error")
	}
}
