package integrations

// The private Git adapter is temporary: it exists only so the still-Go action
// owner can invoke the Bun Git capability without creating a second action
// tree. These tests pin the wire identity, the fallback for every other
// command, the cancellation path and exactly-once command accounting.
import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/friendsfriend/devenv/pkg/actiondef"
	"github.com/friendsfriend/devenv/pkg/actionexec"
)

// stubContext is the minimal StepContext the command handler needs.
type stubContext struct{ ctx context.Context }

func (c stubContext) Context() context.Context         { return c.ctx }
func (stubContext) RunID() actiondef.RunID             { return "run-7" }
func (stubContext) StepID() actiondef.StepDefinitionID { return "get-ref" }
func (stubContext) Require(actiondef.ValueKey) (actiondef.Value, error) {
	return actiondef.Value{}, errors.New("missing")
}
func (stubContext) Set(actiondef.ValueKey, actiondef.Value) error { return nil }
func (stubContext) Executor() actiondef.CommandExecutor           { return nil }
func (stubContext) Events() actiondef.EventSink                   { return nil }
func (stubContext) Secrets() actiondef.SecretResolver             { return nil }

type recordedCommandEvent struct{ events []actionexec.CommandEvent }

func (e *recordedCommandEvent) EmitCommand(event actionexec.CommandEvent) {
	e.events = append(e.events, event)
}

type stubRunner struct{ calls int }

func (r *stubRunner) Run(context.Context, actionexec.CommandSpec, func(string, string)) actionexec.CommandResult {
	r.calls++
	return actionexec.CommandResult{Stdout: "local"}
}

// gitServer serves one forwarded command and records the decoded request.
func gitServer(t *testing.T, status int, outcome GitCommandOutcome) (*httptest.Server, *GitCommandRequest) {
	t.Helper()
	recorded := &GitCommandRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != GitCommandPath {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer private-token" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, recorded); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status >= 300 {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]string{"code": "git-command-cancelled", "message": "cancelled"},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "value": outcome})
	}))
	t.Cleanup(server.Close)
	return server, recorded
}

func TestForwardingRunnerCarriesIdentityAndOutput(t *testing.T) {
	server, recorded := gitServer(t, http.StatusOK, GitCommandOutcome{
		RunID: "run-7", StepID: "get-ref", CommandID: "get-ref-command-0",
		Command: "git -C /checkout rev-parse --abbrev-ref HEAD",
		Stdout:  "main\n", ExitCode: 0,
	})
	events := &recordedCommandEvent{}
	fallback := &stubRunner{}
	handler := actionexec.CommandHandler{
		Runner: ForwardingRunner{Client: NewClient(server.URL, "private-token"), Fallback: fallback},
		Events: events,
	}
	step := actiondef.Step{
		StepID:        "get-ref",
		StepType:      actiondef.StepKindCommand,
		Configuration: map[string]any{"command": "git", "args": []string{"rev-parse", "--abbrev-ref", "HEAD"}, "dir": "/checkout"},
	}
	result := handler.Execute(stubContext{context.Background()}, step)
	if result.Err != nil {
		t.Fatalf("result error: %v", result.Err)
	}
	if fallback.calls != 0 {
		t.Fatalf("fallback ran %d times for a forwarded command", fallback.calls)
	}
	if recorded.Operation != "git.command" || recorded.RunID != "run-7" || recorded.StepID != "get-ref" || recorded.CommandID != "get-ref-command-0" {
		t.Fatalf("identity = %#v", recorded)
	}
	if recorded.Directory != "/checkout" || len(recorded.Args) != 3 {
		t.Fatalf("request = %#v", recorded)
	}
	// Exactly one started/output/completed event, all from the action owner.
	if len(events.events) != 3 {
		t.Fatalf("events = %#v", events.events)
	}
	if events.events[0].Type != "command.started" || events.events[1].Type != "command.output" || events.events[2].Type != "command.completed" {
		t.Fatalf("event order = %#v", events.events)
	}
	if events.events[1].Chunk != "main\n" {
		t.Fatalf("streamed chunk = %q", events.events[1].Chunk)
	}
}

func TestForwardingRunnerRunsEveryOtherCommandLocally(t *testing.T) {
	server, recorded := gitServer(t, http.StatusOK, GitCommandOutcome{})
	fallback := &stubRunner{}
	runner := ForwardingRunner{Client: NewClient(server.URL, "private-token"), Fallback: fallback}
	for _, spec := range []actionexec.CommandSpec{
		{Name: "docker", Args: []string{"ps"}, Dir: "/checkout"},
		// A git step without a directory has no checkout to run in.
		{Name: "git", Args: []string{"--version"}},
	} {
		result := runner.Run(context.Background(), spec, nil)
		if result.Stdout != "local" {
			t.Fatalf("spec %v did not run locally: %#v", spec.Name, result)
		}
	}
	if fallback.calls != 2 {
		t.Fatalf("fallback calls = %d", fallback.calls)
	}
	if recorded.Args != nil {
		t.Fatalf("a local command reached the adapter: %#v", recorded)
	}
}

func TestForwardingRunnerReportsBridgeFailureWithoutRecordingACommand(t *testing.T) {
	server, _ := gitServer(t, http.StatusConflict, GitCommandOutcome{})
	fallback := &stubRunner{}
	runner := ForwardingRunner{Client: NewClient(server.URL, "private-token"), Fallback: fallback}
	result := runner.Run(context.Background(), actionexec.CommandSpec{Name: "git", Dir: "/checkout", Args: []string{"fetch"}}, nil)
	if result.Err == nil || result.ExitCode != -1 {
		t.Fatalf("result = %#v", result)
	}
	if fallback.calls != 0 {
		t.Fatal("a failed bridge must not silently rerun the command locally")
	}
}

func TestForwardingRunnerPropagatesCancellation(t *testing.T) {
	server, _ := gitServer(t, http.StatusOK, GitCommandOutcome{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	runner := ForwardingRunner{Client: NewClient(server.URL, "private-token")}
	result := runner.Run(ctx, actionexec.CommandSpec{Name: "git", Dir: "/checkout", Args: []string{"fetch"}}, nil)
	if result.Err == nil {
		t.Fatal("expected the cancelled request to fail the command")
	}
}

func TestFromEnvRequiresBothURLAndToken(t *testing.T) {
	t.Setenv(URLEnvVar, "")
	t.Setenv(TokenEnvVar, "")
	if _, ok := FromEnv(); ok {
		t.Fatal("an unset URL must not enable forwarding")
	}
	t.Setenv(URLEnvVar, "http://127.0.0.1:4051")
	if _, ok := FromEnv(); !ok {
		t.Fatal("a set URL must enable forwarding")
	}
	client, _ := FromEnv()
	if _, err := client.RunGitCommand(context.Background(), GitCommandRequest{}); err == nil {
		t.Fatal("expected a missing token to fail closed")
	}
}
