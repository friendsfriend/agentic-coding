// Package integrations is the Go-side client for the bounded private Git
// operation served by the Bun backend (`port-git-providers-and-ai-to-bun`,
// task 2.5).
//
// While the Go process still owns action execution, a `git` command step is
// forwarded here instead of being executed locally, so the Git capability has
// exactly one implementation. The action owner keeps recording the command in
// its own run tree: the envelope carries the run/step/command identity and the
// response carries the actual stdout/stderr/exit code.
//
// The adapter is temporary. `port-action-execution-to-bun` task 4.3 replaces
// this bridge with a direct Bun capability call under the Bun action owner.
package integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// GitCommandPath is the private endpoint. It is deliberately not below the
// delegated legacy surface, so a forwarded request can never be proxied back
// into this process.
const GitCommandPath = "/api/v1/integrations/private/git-command"

// maxResponseBytes bounds a private response.
const maxResponseBytes = 16 * 1024 * 1024

// Environment variables the owning Bun process passes to this child. They are
// set only when Bun owns the Git capability, so a child that does not receive
// them keeps executing Git commands itself.
const (
	URLEnvVar   = "DEVENV_INTEGRATIONS_URL"
	TokenEnvVar = "DEVENV_INTEGRATIONS_TOKEN"
)

// Error is a bounded private-operation failure: a stable code plus a message
// that never contains a token or a raw payload.
type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("integrations %s: %s", e.Code, e.Message)
}

// GitCommandRequest is one forwarded argv invocation with its run identity.
type GitCommandRequest struct {
	Operation string   `json:"operation"`
	RunID     string   `json:"runId"`
	StepID    string   `json:"stepId"`
	CommandID string   `json:"commandId"`
	Directory string   `json:"directory"`
	Args      []string `json:"args"`
}

// GitCommandOutcome is what the Bun side executed and observed. Bun resolves
// any provider credential itself, so no credential crosses this boundary.
type GitCommandOutcome struct {
	RunID     string `json:"runId"`
	StepID    string `json:"stepId"`
	CommandID string `json:"commandId"`
	Command   string `json:"command"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  int    `json:"exitCode"`
	Cancelled bool   `json:"cancelled"`
	Truncated bool   `json:"truncated"`
}

// Client speaks the private Git operation protocol.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// NewClient builds a client for the given base URL and instance token.
func NewClient(baseURL, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 15 * time.Minute},
	}
}

// FromEnv returns the client described by the process environment, and whether
// this process should forward Git commands to Bun.
func FromEnv() (*Client, bool) {
	baseURL := strings.TrimSpace(os.Getenv(URLEnvVar))
	if baseURL == "" {
		return nil, false
	}
	return NewClient(baseURL, os.Getenv(TokenEnvVar)), true
}

type commandResponse struct {
	OK    bool              `json:"ok"`
	Value GitCommandOutcome `json:"value"`
	Error *Error            `json:"error"`
}

// RunGitCommand forwards one argv invocation. Cancellation of ctx aborts the
// request, which makes the Bun side kill the child process it started.
func (c *Client) RunGitCommand(ctx context.Context, request GitCommandRequest) (GitCommandOutcome, error) {
	if c.token == "" {
		return GitCommandOutcome{}, &Error{
			Status:  http.StatusUnauthorized,
			Code:    "integrations-token-missing",
			Message: fmt.Sprintf("%s is set but %s is empty", URLEnvVar, TokenEnvVar),
		}
	}
	request.Operation = "git.command"
	body, err := json.Marshal(request)
	if err != nil {
		return GitCommandOutcome{}, fmt.Errorf("integrations git.command: encode request: %w", err)
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+GitCommandPath,
		bytes.NewReader(body),
	)
	if err != nil {
		return GitCommandOutcome{}, fmt.Errorf("integrations git.command: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	response, err := c.http.Do(req)
	if err != nil {
		return GitCommandOutcome{}, fmt.Errorf("integrations git.command: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return GitCommandOutcome{}, fmt.Errorf("integrations git.command: read response: %w", err)
	}
	var decoded commandResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return GitCommandOutcome{}, &Error{
			Status:  response.StatusCode,
			Code:    "integrations-protocol",
			Message: fmt.Sprintf("git.command: unreadable response (status %d)", response.StatusCode),
		}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || !decoded.OK {
		failure := decoded.Error
		if failure == nil {
			failure = &Error{Code: "integrations-failed", Message: "git.command"}
		}
		failure.Status = response.StatusCode
		return GitCommandOutcome{}, failure
	}
	return decoded.Value, nil
}
