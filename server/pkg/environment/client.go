// Package environment is the Go-side client for the bounded private
// environment operations served by the Bun backend
// (port-project-catalog-and-state-to-bun, task 3.2).
//
// In migrated mode Bun is the sole environment-state schema and mutation
// authority: this process holds no writable SQLite handle and does not parse
// configuration itself. Every state/config access goes through one typed
// operation per logical unit of work, so an update that must be atomic stays
// atomic and no SQL ever crosses the boundary.
package environment

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

// OperationPath is the private endpoint. It is deliberately not below the
// delegated environment prefix, so a request can never be proxied back into
// this process.
const OperationPath = "/api/v1/environment/private/state"

// maxResponseBytes bounds a private response. History reads are the largest
// payload; anything above this is a protocol error, not a big result.
const maxResponseBytes = 64 * 1024 * 1024

// Environment variables the owning parent passes to this child. The URL is set
// only in migrated mode, when Bun owns the environment state.
const (
	URLEnvVar   = "DEVENV_ENVIRONMENT_URL"
	TokenEnvVar = "DEVENV_ENVIRONMENT_TOKEN"
)

// Error is a bounded private-operation failure: a stable code plus a message
// that never contains SQL, a token or a raw payload.
type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("environment %s: %s", e.Code, e.Message)
}

// Client speaks the private operation protocol.
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
		http:    &http.Client{Timeout: 20 * time.Second},
	}
}

// FromEnv returns the client described by the process environment, and whether
// this process is running in migrated (Bun-owned) mode.
func FromEnv() (*Client, bool) {
	baseURL := strings.TrimSpace(os.Getenv(URLEnvVar))
	if baseURL == "" {
		return nil, false
	}
	return NewClient(baseURL, os.Getenv(TokenEnvVar)), true
}

type operationRequest struct {
	Operation string `json:"operation"`
	Params    any    `json:"params"`
}

type operationResponse struct {
	OK    bool            `json:"ok"`
	Value json.RawMessage `json:"value"`
	Error *Error          `json:"error"`
}

// call performs one operation and decodes its value into out (which may be
// nil when the operation returns nothing).
func (c *Client) call(ctx context.Context, operation string, params any, out any) error {
	if c.token == "" {
		return &Error{
			Status:  http.StatusUnauthorized,
			Code:    "environment-token-missing",
			Message: fmt.Sprintf("%s is set but %s is empty", URLEnvVar, TokenEnvVar),
		}
	}
	body, err := encodeOperation(operation, params)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+OperationPath,
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("environment %s: build request: %w", operation, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	response, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("environment %s: %w", operation, err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("environment %s: read response: %w", operation, err)
	}
	var decoded operationResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return &Error{
			Status:  response.StatusCode,
			Code:    "environment-protocol",
			Message: fmt.Sprintf("%s: unreadable response (status %d)", operation, response.StatusCode),
		}
	}
	if !responseStatusOK(response.StatusCode) || !decoded.OK {
		failure := decoded.Error
		if failure == nil {
			failure = &Error{Code: "environment-failed", Message: operation}
		}
		failure.Status = response.StatusCode
		return failure
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(decoded.Value, out); err != nil {
		return fmt.Errorf("environment %s: decode value: %w", operation, err)
	}
	return nil
}

func responseStatusOK(status int) bool {
	return status >= 200 && status < 300
}

// encodeOperation builds the exact request body one private operation sends.
// Shared with the contract test so the checked-in cross-runtime fixture is
// produced by the same code that talks to the authority.
func encodeOperation(operation string, params any) ([]byte, error) {
	if params == nil {
		params = struct{}{}
	}
	body, err := json.Marshal(operationRequest{Operation: operation, Params: params})
	if err != nil {
		return nil, fmt.Errorf("environment %s: encode request: %w", operation, err)
	}
	return body, nil
}
