package environment

// Cross-runtime contract fixtures (port-project-catalog-and-state-to-bun,
// tasks 3.2/4.1).
//
// The private operation envelope is the one interface both runtimes must agree
// on, so it is pinned as a checked-in fixture: this test asserts the Go client's
// encoded body byte-for-byte, and the Bun test decodes and executes the same
// file. Either side drifting on a field name, a timestamp format or an
// operation name fails on its own side.
//
// Regenerate with:
//
//	DEVENV_ENV_OPERATION_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/environment/operations \
//	  go test ./pkg/environment -run TestOperationEnvelopesMatchContract
import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/friendsfriend/devenv/pkg/app"
	"github.com/friendsfriend/devenv/pkg/state"
)

// envelopeCase is one captured request: the file name and the exact operation
// the Go client would send.
type envelopeCase struct {
	name      string
	operation string
	params    any
}

// fixedTimestamp keeps the captured cursors stable; the value is the format
// the state database stores.
var fixedTimestamp = time.Date(2024, 4, 5, 6, 7, 11, 0, time.UTC)

func envelopeCases() []envelopeCase {
	return []envelopeCase{
		{
			name:      "state.setAppState",
			operation: "state.setAppState",
			params: storePayload{
				Ident:              "leased-app",
				Branch:             "feature/x",
				ActiveWorktree:     "feature/x",
				MainWorktreeBranch: "main",
			},
		},
		{
			name:      "state.getAppState",
			operation: "state.getAppState",
			params:    map[string]string{"ident": "leased-app"},
		},
		{
			name:      "state.setAppRunTargetInfo",
			operation: "state.setAppRunTargetInfo",
			params: map[string]any{
				"ident": "leased-app",
				"info": runTargetPayload{
					Runtime:    "docker",
					LaunchMode: "compose",
					Label:      "local",
					Profile:    "dev",
					TargetID:   "app:local",
					SourcePath: "/srv/app",
					StartedAt:  "2024-03-04T05:06:07Z",
					Display:    "docker:local",
				},
			},
		},
		{
			name:      "state.getActionEventsBetween",
			operation: "state.getActionEventsBetween",
			params: map[string]any{
				"limit":  50000,
				"since":  eventTimestamp(fixedTimestamp),
				"before": eventTimestamp(fixedTimestamp.Add(time.Hour)),
			},
		},
		{
			name:      "state.addActionLogEvent",
			operation: "state.addActionLogEvent",
			params: map[string]any{
				"runId":      "run-A",
				"stepId":     "step-a",
				"eventJson":  `{"type":"action.step.output","properties":{"output":"line"}}`,
				"maxEntries": 50000,
			},
		},
		{
			name:      "state.addScriptArgsHistory",
			operation: "state.addScriptArgsHistory",
			params: map[string]any{
				"relativePath": "scripts/build.sh",
				"values":       map[string]string{"target": "release"},
				"maxEntries":   50,
			},
		},
		{
			name:      "state.setDependencyLease",
			operation: "state.setDependencyLease",
			params: leasePayload{
				TargetID:   "lease:db",
				OwnerRunID: "run-A",
				OwnerApp:   "leased-app",
				Lifecycle:  "owned",
				UpdatedAt:  "2024-04-05T06:07:08Z",
			},
		},
		{
			name:      "manager.addApp",
			operation: "manager.addApp",
			params: map[string]any{"app": app.App{
				Ident:              "beta",
				DisplayName:        "Beta",
				RepositoryPath:     "https://example.com/team/beta.git",
				AppType:            app.TypeAPP,
				LocalDirectoryPath: "/home/devenv/beta/beta",
				Branch:             "main",
			}},
		},
		{
			name:      "manager.updateAppActiveWorktree",
			operation: "manager.updateAppActiveWorktree",
			params:    map[string]string{"ident": "alpha", "branch": "feature/x"},
		},
		{
			name:      "manager.getProjectCatalog",
			operation: "manager.getProjectCatalog",
			params:    struct{}{},
		},
		{
			name:      "state.getDependencyLeases",
			operation: "state.getDependencyLeases",
			params:    struct{}{},
		},
		{
			name:      "state.setBranch",
			operation: "state.setBranch",
			params:    map[string]string{"ident": "alpha", "branch": "main"},
		},
		{
			name:      "state.getScriptArgsHistory",
			operation: "state.getScriptArgsHistory",
			params:    map[string]any{"relativePath": "scripts/build.sh", "limit": 50},
		},
		{
			name:      "state.getActionLogEvents",
			operation: "state.getActionLogEvents",
			params:    map[string]any{"runId": "run-A", "stepId": "step-a", "limit": 50000},
		},
		{
			name:      "state.clearAppRunTargetInfo",
			operation: "state.clearAppRunTargetInfo",
			params:    map[string]string{"ident": "leased-app"},
		},
		{
			name:      "manager.removeApp",
			operation: "manager.removeApp",
			params:    map[string]any{"ident": "beta", "deleteDir": false},
		},
		{
			name:      "manager.setMainWorktreeBranch",
			operation: "manager.setMainWorktreeBranch",
			params:    map[string]string{"ident": "alpha", "branch": "main"},
		},
		{
			name:      "state.deleteDependencyLease",
			operation: "state.deleteDependencyLease",
			params:    map[string]string{"targetId": "lease:db", "ownerRunId": "run-A"},
		},
		{
			name:      "state.addActionEvent",
			operation: "state.addActionEvent",
			params: map[string]any{
				"eventJson":  `{"type":"action.run.started","properties":{"runId":"run-A"}}`,
				"maxEntries": 50000,
			},
		},
		{
			name:      "manager.saveConfig",
			operation: "manager.saveConfig",
			params:    struct{}{},
		},
		{
			name:      "manager.loadConfig",
			operation: "manager.loadConfig",
			params:    struct{}{},
		},
	}
}

// fixtureDirectory is the checked-in cross-runtime contract location.
func fixtureDirectory() string {
	return filepath.Join("..", "..", "..", "agentic-coding", "test", "fixtures", "environment", "operations")
}

func TestOperationEnvelopesMatchContract(t *testing.T) {
	dir := fixtureDirectory()
	writeDir := os.Getenv("DEVENV_ENV_OPERATION_FIXTURE_DIR")
	if writeDir != "" {
		dir = writeDir
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, testCase := range envelopeCases() {
		t.Run(testCase.name, func(t *testing.T) {
			encoded, err := encodeOperation(testCase.operation, testCase.params)
			if err != nil {
				t.Fatal(err)
			}
			// The body must be a valid, printable envelope.
			var decoded struct {
				Operation string          `json:"operation"`
				Params    json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(encoded, &decoded); err != nil {
				t.Fatalf("encoded body is not a valid envelope: %v", err)
			}
			if decoded.Operation != testCase.operation {
				t.Fatalf("operation %q encoded as %q", testCase.operation, decoded.Operation)
			}
			path := filepath.Join(dir, testCase.name+".json")
			if writeDir != "" {
				if err := os.WriteFile(path, append(encoded, '\n'), 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			expected, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("missing contract fixture (regenerate with DEVENV_ENV_OPERATION_FIXTURE_DIR): %v", err)
			}
			if string(encoded) != string(trimNewline(expected)) {
				t.Fatalf("contract drift for %s:\n go:      %s\n fixture: %s", testCase.name, encoded, expected)
			}
		})
	}
}

func trimNewline(raw []byte) []byte {
	for len(raw) > 0 && (raw[len(raw)-1] == '\n' || raw[len(raw)-1] == '\r') {
		raw = raw[:len(raw)-1]
	}
	return raw
}

// TestStoreEncodingRoundTrip keeps the mapping helpers honest: a value that
// goes through the client's payload types must come back unchanged.
func TestStoreEncodingRoundTrip(t *testing.T) {
	original := state.AppState{
		Ident:              "alpha",
		Branch:             "feature/x",
		ActiveWorktree:     "feature/x",
		MainWorktreeBranch: "main",
	}
	encoded, err := encodeOperation("state.setAppState", storePayload{
		Ident:              original.Ident,
		Branch:             original.Branch,
		ActiveWorktree:     original.ActiveWorktree,
		MainWorktreeBranch: original.MainWorktreeBranch,
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Params storePayload `json:"params"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Params != (storePayload{
		Ident:              original.Ident,
		Branch:             original.Branch,
		ActiveWorktree:     original.ActiveWorktree,
		MainWorktreeBranch: original.MainWorktreeBranch,
	}) {
		t.Fatalf("round trip changed the payload: %+v", decoded.Params)
	}
}
