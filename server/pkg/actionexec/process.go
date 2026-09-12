package actionexec

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/friendsfriend/devenv/pkg/actiondef"
)

const DefaultStabilizationInterval = time.Second

type ProcessHandle struct {
	Mode      string    `json:"mode"`
	PID       int       `json:"pid,omitempty"`
	PaneID    string    `json:"paneId,omitempty"`
	StartedAt time.Time `json:"startedAt"`
}
type ProcessResult struct {
	Handle ProcessHandle
	Err    error
}
type ProcessStore interface {
	Put(string, ProcessHandle)
	Get(string) (ProcessHandle, bool)
	Delete(string)
}
type MemoryProcessStore struct {
	mu      sync.RWMutex
	handles map[string]ProcessHandle
}

func NewMemoryProcessStore() *MemoryProcessStore {
	return &MemoryProcessStore{handles: map[string]ProcessHandle{}}
}
func (s *MemoryProcessStore) Put(k string, h ProcessHandle) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handles[k] = h
}
func (s *MemoryProcessStore) Get(k string) (ProcessHandle, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	h, ok := s.handles[k]
	return h, ok
}
func (s *MemoryProcessStore) Delete(k string) { s.mu.Lock(); defer s.mu.Unlock(); delete(s.handles, k) }
func (s *MemoryProcessStore) KillAll() {
	s.mu.Lock()
	handles := make([]ProcessHandle, 0, len(s.handles))
	for _, handle := range s.handles {
		handles = append(handles, handle)
	}
	s.handles = make(map[string]ProcessHandle)
	s.mu.Unlock()
	for _, handle := range handles {
		if handle.PID <= 0 {
			continue
		}
		if process, err := os.FindProcess(handle.PID); err == nil {
			_ = process.Kill()
		}
	}
}

type ProcessHandler struct {
	Store  ProcessStore
	Events CommandEventSink
}

type processOutputWriter struct {
	stream string
	stepID actiondef.StepDefinitionID
	events CommandEventSink
	file   *os.File
	writes atomic.Int64
}

func (w *processOutputWriter) Write(data []byte) (int, error) {
	w.writes.Add(1)
	if w.events != nil {
		w.events.EmitCommand(CommandEvent{Type: "command.output", StepID: w.stepID, Stream: w.stream, Chunk: string(data)})
	}
	if w.file != nil {
		_, _ = w.file.Write(data)
	}
	return len(data), nil
}

func (ProcessHandler) Supports(kind actiondef.StepKind) bool {
	return kind == actiondef.StepKindProcess
}
func (h ProcessHandler) Execute(ctx actiondef.StepContext, definition actiondef.StepDefinition) actiondef.StepResult {
	step, ok := definition.(actiondef.Step)
	if !ok {
		return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: fmt.Errorf("unsupported process descriptor")}
	}
	spec, err := commandSpec(step.Configuration)
	if err != nil {
		return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: err}
	}
	// Managed processes outlive the action execution context. Using
	// CommandContext would kill long-running processes (including kubectl
	// port-forward) when the action timeout expires.
	cmd := exec.Command(spec.Name, spec.Args...)
	cmd.Dir = spec.Dir
	if len(spec.Env) > 0 {
		cmd.Env = append(os.Environ(), spec.Env...)
	}
	var logFile *os.File
	if logPath, ok := step.Configuration["logPath"].(string); ok && logPath != "" {
		logFile, _ = os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	}
	cmd.Stdout = &processOutputWriter{stream: "stdout", stepID: definition.ID(), events: h.Events, file: logFile}
	cmd.Stderr = &processOutputWriter{stream: "stderr", stepID: definition.ID(), events: h.Events, file: logFile}
	if err := cmd.Start(); err != nil {
		return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: err}
	}
	handle := ProcessHandle{Mode: "process", PID: cmd.Process.Pid, StartedAt: time.Now()}
	handleKey := string(definition.ID())
	if configured, ok := step.Configuration["handleKey"].(string); ok && configured != "" {
		handleKey = configured
	}
	if h.Store != nil {
		h.Store.Put(handleKey, handle)
	}
	if exports, ok := step.Configuration["endpointExports"].([]actiondef.EndpointValue); ok {
		for _, endpoint := range exports {
			if err := ctx.Set(actiondef.ValueKey("endpoint."+endpoint.Name), actiondef.Value{Type: actiondef.ValueTypeEndpoint, Visibility: actiondef.VisibilityPublic, Data: endpoint}); err != nil {
				return actiondef.StepResult{Outcome: actiondef.OutcomeFailed, Err: err}
			}
		}
	}
	go func() {
		_ = cmd.Wait()
		if h.Store != nil {
			h.Store.Delete(handleKey)
		}
		if logFile != nil {
			_ = logFile.Close()
		}
	}()
	return actiondef.StepResult{Outcome: actiondef.OutcomeExecuted}
}

type ReadinessProbe interface{ Wait(context.Context) error }
type ProbeFunc func(context.Context) error

func (f ProbeFunc) Wait(ctx context.Context) error { return f(ctx) }

type CommandProbe struct {
	Runner CommandRunner
	Spec   CommandSpec
}

func (p CommandProbe) Wait(ctx context.Context) error {
	result := p.Runner.Run(ctx, p.Spec, nil)
	return result.Err
}

type ProcessSurvivalProbe struct {
	PID       int
	PaneAlive func() bool
	Interval  time.Duration
}

func (p ProcessSurvivalProbe) Wait(ctx context.Context) error {
	interval := p.Interval
	if interval <= 0 {
		interval = DefaultStabilizationInterval
	}
	timer := time.NewTimer(interval)
	defer timer.Stop()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return nil
		case <-ticker.C:
			if p.PaneAlive != nil {
				if !p.PaneAlive() {
					return fmt.Errorf("tmux pane exited before readiness")
				}
			} else if processDead(p.PID) {
				return fmt.Errorf("process %d exited before readiness", p.PID)
			}
		}
	}
}
func processDead(pid int) bool {
	if pid <= 0 {
		return true
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return true
	}
	return process.Signal(syscall.Signal(0)) != nil
}

type TCPProbe struct {
	Address  string
	Interval time.Duration
}

func (p TCPProbe) Wait(ctx context.Context) error {
	return poll(ctx, p.Interval, func() error {
		conn, err := net.DialTimeout("tcp", p.Address, 250*time.Millisecond)
		if err == nil {
			conn.Close()
		}
		return err
	})
}

type HTTPProbe struct {
	URL      string
	Client   *http.Client
	Interval time.Duration
}

func (p HTTPProbe) Wait(ctx context.Context) error {
	return poll(ctx, p.Interval, func() error {
		client := p.Client
		if client == nil {
			client = &http.Client{Timeout: time.Second}
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, p.URL, nil)
		res, err := client.Do(req)
		if err != nil {
			return err
		}
		res.Body.Close()
		if res.StatusCode >= 400 {
			return fmt.Errorf("readiness HTTP status %d", res.StatusCode)
		}
		return nil
	})
}
func poll(ctx context.Context, interval time.Duration, check func() error) error {
	if interval <= 0 {
		interval = 100 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := check(); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
