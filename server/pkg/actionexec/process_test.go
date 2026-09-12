package actionexec

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

func TestProcessHandlerStreamsOutputAndPreservesLog(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "process.log")
	output := make(chan CommandEvent, 2)
	sink := processEventChannel(output)
	store := NewMemoryProcessStore()
	handler := ProcessHandler{Store: store, Events: sink}
	ctx := commandContext{context.Background()}
	step := actiondef.Step{StepID: "start", StepType: actiondef.StepKindProcess, Configuration: map[string]any{"command": "sh", "args": []string{"-c", "echo stdout; echo stderr >&2"}, "logPath": logPath}}
	if result := handler.Execute(ctx, step); result.Err != nil {
		t.Fatal(result.Err)
	}
	deadline := time.After(time.Second)
	for len(output) < 2 {
		select {
		case <-deadline:
			t.Fatal("missing process output")
		case <-time.After(10 * time.Millisecond):
		}
	}
	content, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(content)
	if !strings.Contains(text, "stdout") || !strings.Contains(text, "stderr") {
		t.Fatalf("log=%q", text)
	}
}

func TestManagedProcessOutlivesActionContext(t *testing.T) {
	store := NewMemoryProcessStore()
	handler := ProcessHandler{Store: store}
	ctx, cancel := context.WithCancel(context.Background())
	step := actiondef.Step{StepID: "port-forward", StepType: actiondef.StepKindProcess, Configuration: map[string]any{"command": "sh", "args": []string{"-c", "sleep 30"}}}
	if result := handler.Execute(commandContext{ctx}, step); result.Err != nil {
		t.Fatal(result.Err)
	}
	handle, ok := store.Get("port-forward")
	if !ok {
		t.Fatal("missing process handle")
	}
	process, err := os.FindProcess(handle.PID)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Kill()
	cancel()
	time.Sleep(100 * time.Millisecond)
	if processDead(handle.PID) {
		t.Fatal("managed process stopped with action context")
	}
	store.KillAll()
	deadline := time.Now().Add(time.Second)
	for !processDead(handle.PID) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !processDead(handle.PID) {
		t.Fatal("managed process survived store shutdown")
	}
}

type processEventChannel chan CommandEvent

func (c processEventChannel) EmitCommand(event CommandEvent) {
	if event.Type == "command.output" {
		c <- event
	}
}

func TestProcessSurvivalCompatibilityReadiness(t *testing.T) {
	if err := (ProcessSurvivalProbe{PaneAlive: func() bool { return true }, Interval: 20 * time.Millisecond}).Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := (ProcessSurvivalProbe{PaneAlive: func() bool { return false }, Interval: time.Second}).Wait(context.Background()); err == nil {
		t.Fatal("expected exited pane failure")
	}
}
func TestTCPAndHTTPReadiness(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := (TCPProbe{Address: listener.Addr().String()}).Wait(ctx); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer server.Close()
	if err := (HTTPProbe{URL: server.URL}).Wait(ctx); err != nil {
		t.Fatal(err)
	}
}
func TestMemoryProcessStore(t *testing.T) {
	store := NewMemoryProcessStore()
	handle := ProcessHandle{Mode: "process", PID: 42}
	store.Put("start", handle)
	if got, ok := store.Get("start"); !ok || got.PID != 42 {
		t.Fatalf("got=%#v ok=%v", got, ok)
	}
	store.Delete("start")
	if _, ok := store.Get("start"); ok {
		t.Fatal("handle not deleted")
	}
}
