package state

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// openTemp opens a fresh state store in a temporary directory and registers
// cleanup via t.Cleanup.
func openTemp(t *testing.T) Store {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// TestOpenCreatesFile verifies that Open creates the database file.
func TestOpenCreatesFile(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	if _, err := os.Stat(filepath.Join(dir, "state.db")); err != nil {
		t.Fatalf("expected state.db to exist: %v", err)
	}
}

// TestOpenCreatesDirectory verifies that Open creates a nested db directory if
// it does not already exist.
func TestOpenCreatesDirectory(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "nested", "db")

	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open with non-existent nested dir: %v", err)
	}
	defer s.Close()

	if _, err := os.Stat(filepath.Join(dir, "state.db")); err != nil {
		t.Fatalf("expected state.db inside created nested dir: %v", err)
	}
}

// TestGetAppStateUnknownIdent verifies that a missing ident returns a
// zero-value AppState rather than an error.
func TestGetAppStateUnknownIdent(t *testing.T) {
	s := openTemp(t)

	st, err := s.GetAppState("nonexistent")
	if err != nil {
		t.Fatalf("GetAppState on unknown ident: %v", err)
	}
	if st.Ident != "nonexistent" {
		t.Fatalf("expected Ident=%q, got %q", "nonexistent", st.Ident)
	}
	if st.Branch != "" || st.ActiveWorktree != "" {
		t.Fatalf("expected empty state, got %+v", st)
	}
}

// TestSetBranchAndGet verifies that SetBranch persists correctly.
func TestSetBranchAndGet(t *testing.T) {
	s := openTemp(t)

	if err := s.SetBranch("app-a", "main"); err != nil {
		t.Fatalf("SetBranch: %v", err)
	}

	st, err := s.GetAppState("app-a")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if st.Branch != "main" {
		t.Fatalf("expected branch=%q, got %q", "main", st.Branch)
	}
	// ActiveWorktree should remain empty when only branch is set via SetBranch.
	if st.ActiveWorktree != "" {
		t.Fatalf("expected empty ActiveWorktree, got %q", st.ActiveWorktree)
	}
}

// TestSetBranchOverwrite verifies that calling SetBranch twice updates the value
// without touching active_worktree.
func TestSetBranchOverwrite(t *testing.T) {
	s := openTemp(t)

	if err := s.SetActiveWorktree("app-a", "feature-x"); err != nil {
		t.Fatalf("SetActiveWorktree: %v", err)
	}
	if err := s.SetBranch("app-a", "main"); err != nil {
		t.Fatalf("SetBranch first: %v", err)
	}
	if err := s.SetBranch("app-a", "develop"); err != nil {
		t.Fatalf("SetBranch second: %v", err)
	}

	st, err := s.GetAppState("app-a")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if st.Branch != "develop" {
		t.Fatalf("expected branch=%q, got %q", "develop", st.Branch)
	}
	// Previously stored active_worktree must be preserved.
	if st.ActiveWorktree != "feature-x" {
		t.Fatalf("expected ActiveWorktree=%q, got %q", "feature-x", st.ActiveWorktree)
	}
}

// TestSetActiveWorktreeAndGet verifies that SetActiveWorktree persists correctly.
func TestSetActiveWorktreeAndGet(t *testing.T) {
	s := openTemp(t)

	if err := s.SetActiveWorktree("app-b", "feature/login"); err != nil {
		t.Fatalf("SetActiveWorktree: %v", err)
	}

	st, err := s.GetAppState("app-b")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if st.ActiveWorktree != "feature/login" {
		t.Fatalf("expected ActiveWorktree=%q, got %q", "feature/login", st.ActiveWorktree)
	}
}

// TestSetActiveWorktreePreservesBranch verifies that SetActiveWorktree does not
// clobber a previously stored branch value.
func TestSetActiveWorktreePreservesBranch(t *testing.T) {
	s := openTemp(t)

	if err := s.SetBranch("app-b", "main"); err != nil {
		t.Fatalf("SetBranch: %v", err)
	}
	if err := s.SetActiveWorktree("app-b", "feature/login"); err != nil {
		t.Fatalf("SetActiveWorktree: %v", err)
	}

	st, err := s.GetAppState("app-b")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if st.Branch != "main" {
		t.Fatalf("expected Branch=%q, got %q", "main", st.Branch)
	}
	if st.ActiveWorktree != "feature/login" {
		t.Fatalf("expected ActiveWorktree=%q, got %q", "feature/login", st.ActiveWorktree)
	}
}

// TestSetAppStateUpsert verifies that SetAppState creates and updates both fields
// atomically.
func TestSetAppStateUpsert(t *testing.T) {
	s := openTemp(t)

	first := AppState{Ident: "app-c", Branch: "main", ActiveWorktree: "feat"}
	if err := s.SetAppState(first); err != nil {
		t.Fatalf("SetAppState (insert): %v", err)
	}

	got, err := s.GetAppState("app-c")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if got.Branch != "main" || got.ActiveWorktree != "feat" {
		t.Fatalf("after insert: got %+v, want %+v", got, first)
	}

	second := AppState{Ident: "app-c", Branch: "develop", ActiveWorktree: "other"}
	if err := s.SetAppState(second); err != nil {
		t.Fatalf("SetAppState (update): %v", err)
	}

	got, err = s.GetAppState("app-c")
	if err != nil {
		t.Fatalf("GetAppState after update: %v", err)
	}
	if got.Branch != "develop" || got.ActiveWorktree != "other" {
		t.Fatalf("after update: got %+v, want %+v", got, second)
	}
}

// TestMultipleAppsIndependent verifies that state for different apps is stored
// independently.
func TestMultipleAppsIndependent(t *testing.T) {
	s := openTemp(t)

	if err := s.SetBranch("alpha", "main"); err != nil {
		t.Fatalf("SetBranch alpha: %v", err)
	}
	if err := s.SetBranch("beta", "develop"); err != nil {
		t.Fatalf("SetBranch beta: %v", err)
	}

	alpha, err := s.GetAppState("alpha")
	if err != nil {
		t.Fatalf("GetAppState alpha: %v", err)
	}
	beta, err := s.GetAppState("beta")
	if err != nil {
		t.Fatalf("GetAppState beta: %v", err)
	}

	if alpha.Branch != "main" {
		t.Fatalf("alpha.Branch: got %q, want %q", alpha.Branch, "main")
	}
	if beta.Branch != "develop" {
		t.Fatalf("beta.Branch: got %q, want %q", beta.Branch, "develop")
	}
}

// TestMigrationIdempotent verifies that opening the same database directory
// multiple times does not fail and preserves existing data.
func TestMigrationIdempotent(t *testing.T) {
	dir := t.TempDir()

	// First open — creates schema.
	s1, err := Open(dir)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	if err := s1.SetBranch("app-d", "main"); err != nil {
		t.Fatalf("SetBranch: %v", err)
	}
	if err := s1.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}

	// Second open — migration must not corrupt existing data.
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer s2.Close()

	st, err := s2.GetAppState("app-d")
	if err != nil {
		t.Fatalf("GetAppState after re-open: %v", err)
	}
	if st.Branch != "main" {
		t.Fatalf("data not preserved after re-open: got branch=%q", st.Branch)
	}
}

// TestSetMainWorktreeBranchAndGet verifies that SetMainWorktreeBranch persists
// correctly and does not clobber other fields.
func TestSetMainWorktreeBranchAndGet(t *testing.T) {
	s := openTemp(t)

	// Seed branch and active worktree first.
	if err := s.SetBranch("app-wt", "main"); err != nil {
		t.Fatalf("SetBranch: %v", err)
	}
	if err := s.SetActiveWorktree("app-wt", "feature-x"); err != nil {
		t.Fatalf("SetActiveWorktree: %v", err)
	}

	if err := s.SetMainWorktreeBranch("app-wt", "main"); err != nil {
		t.Fatalf("SetMainWorktreeBranch: %v", err)
	}

	st, err := s.GetAppState("app-wt")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if st.MainWorktreeBranch != "main" {
		t.Fatalf("expected MainWorktreeBranch=%q, got %q", "main", st.MainWorktreeBranch)
	}
	// Other fields must be preserved.
	if st.Branch != "main" {
		t.Fatalf("expected Branch=%q, got %q", "main", st.Branch)
	}
	if st.ActiveWorktree != "feature-x" {
		t.Fatalf("expected ActiveWorktree=%q, got %q", "feature-x", st.ActiveWorktree)
	}
}

// TestSetMainWorktreeBranchUpsert verifies that SetMainWorktreeBranch creates a
// row when none exists yet (i.e., it is called before any other setter).
func TestSetMainWorktreeBranchUpsert(t *testing.T) {
	s := openTemp(t)

	if err := s.SetMainWorktreeBranch("app-new", "develop"); err != nil {
		t.Fatalf("SetMainWorktreeBranch on fresh ident: %v", err)
	}

	st, err := s.GetAppState("app-new")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if st.MainWorktreeBranch != "develop" {
		t.Fatalf("expected MainWorktreeBranch=%q, got %q", "develop", st.MainWorktreeBranch)
	}
}

// TestSetMainWorktreeBranchOverwrite verifies that calling SetMainWorktreeBranch
// twice updates the value.
func TestSetMainWorktreeBranchOverwrite(t *testing.T) {
	s := openTemp(t)

	if err := s.SetMainWorktreeBranch("app-ow", "main"); err != nil {
		t.Fatalf("SetMainWorktreeBranch first: %v", err)
	}
	if err := s.SetMainWorktreeBranch("app-ow", "master"); err != nil {
		t.Fatalf("SetMainWorktreeBranch second: %v", err)
	}

	st, err := s.GetAppState("app-ow")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if st.MainWorktreeBranch != "master" {
		t.Fatalf("expected MainWorktreeBranch=%q, got %q", "master", st.MainWorktreeBranch)
	}
}

// TestSetAppStateUpsertWithMainWorktreeBranch verifies that SetAppState
// round-trips MainWorktreeBranch correctly.
func TestSetAppStateUpsertWithMainWorktreeBranch(t *testing.T) {
	s := openTemp(t)

	first := AppState{Ident: "app-e", Branch: "main", ActiveWorktree: "feat", MainWorktreeBranch: "main"}
	if err := s.SetAppState(first); err != nil {
		t.Fatalf("SetAppState (insert): %v", err)
	}

	got, err := s.GetAppState("app-e")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if got.MainWorktreeBranch != "main" {
		t.Fatalf("after insert: got MainWorktreeBranch=%q, want %q", got.MainWorktreeBranch, "main")
	}

	second := AppState{Ident: "app-e", Branch: "develop", ActiveWorktree: "other", MainWorktreeBranch: "develop"}
	if err := s.SetAppState(second); err != nil {
		t.Fatalf("SetAppState (update): %v", err)
	}

	got, err = s.GetAppState("app-e")
	if err != nil {
		t.Fatalf("GetAppState after update: %v", err)
	}
	if got.MainWorktreeBranch != "develop" {
		t.Fatalf("after update: got MainWorktreeBranch=%q, want %q", got.MainWorktreeBranch, "develop")
	}
}

// TestMigrationIdempotentWithMainWorktreeBranch verifies that v2 migration
// preserves existing rows and allows MainWorktreeBranch to be set afterward.
func TestActionEventHistoryPersistsAndRetainsOrder(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AddActionEvent(`{"type":"old"}`, 2); err != nil {
		t.Fatal(err)
	}
	if err := store.AddActionEvent(`{"type":"action.started"}`, 2); err != nil {
		t.Fatal(err)
	}
	if err := store.AddActionEvent(`{"type":"action.completed"}`, 2); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	events, err := store.GetActionEvents(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0] != `{"type":"action.started"}` || events[1] != `{"type":"action.completed"}` {
		t.Fatalf("events = %v", events)
	}
}

func TestActionLogMigrationMovesLegacyOutputEvents(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	sqlite := store.(*sqliteStore)
	legacy := `{"type":"action.step.output","properties":{"runId":"run-1","stepId":"build","commandId":"command","stream":"stdout","output":"legacy"}}`
	if _, err := sqlite.db.Exec(`INSERT INTO action_events (event_json) VALUES (?)`, legacy); err != nil {
		t.Fatal(err)
	}
	if _, err := sqlite.db.Exec(`UPDATE schema_meta SET value = '6' WHERE key = 'version'`); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	logs, err := store.GetActionLogEvents("run-1", "build", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 || logs[0] != legacy {
		t.Fatalf("logs = %v", logs)
	}
	history, err := store.GetActionEvents(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 0 {
		t.Fatalf("history = %v", history)
	}
}

func TestActionLogsAreStoredIndependentlyByRunAndStep(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.AddActionEvent(`{"type":"action.started"}`, 10); err != nil {
		t.Fatal(err)
	}
	if err := store.AddActionLogEvent("run-1", "build", `{"type":"action.step.output","properties":{"output":"build"}}`, 10); err != nil {
		t.Fatal(err)
	}
	if err := store.AddActionLogEvent("run-1", "test", `{"type":"action.step.output","properties":{"output":"test"}}`, 10); err != nil {
		t.Fatal(err)
	}
	history, err := store.GetActionEvents(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0] != `{"type":"action.started"}` {
		t.Fatalf("history = %v", history)
	}
	logs, err := store.GetActionLogEvents("run-1", "build", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 || logs[0] != `{"type":"action.step.output","properties":{"output":"build"}}` {
		t.Fatalf("logs = %v", logs)
	}
}

func TestActionEventHistoryFiltersRecentWindow(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.AddActionEvent(`{"type":"old"}`, 10); err != nil {
		t.Fatal(err)
	}
	if err := store.AddActionEvent(`{"type":"recent"}`, 10); err != nil {
		t.Fatal(err)
	}
	sqlite := store.(*sqliteStore)
	if _, err := sqlite.db.Exec(`UPDATE action_events SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 minutes') WHERE id = (SELECT MIN(id) FROM action_events)`); err != nil {
		t.Fatal(err)
	}
	events, err := store.GetActionEventsSince(10, time.Now().Add(-10*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0] != `{"type":"recent"}` {
		t.Fatalf("recent events = %v", events)
	}
}

func TestActionEventHistoryFiltersTimeRange(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for _, event := range []string{`{"type":"old"}`, `{"type":"recent"}`} {
		if err := store.AddActionEvent(event, 10); err != nil {
			t.Fatal(err)
		}
	}
	sqlite := store.(*sqliteStore)
	if _, err := sqlite.db.Exec(`UPDATE action_events SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 minutes') WHERE id = (SELECT MIN(id) FROM action_events)`); err != nil {
		t.Fatal(err)
	}
	events, err := store.GetActionEventsBetween(10, time.Now().Add(-24*time.Hour), time.Now().Add(-10*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0] != `{"type":"old"}` {
		t.Fatalf("older events = %v", events)
	}
}

func TestActionEventHistoryExpiresAfter24Hours(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.AddActionEvent(`{"type":"action.started"}`, 10); err != nil {
		t.Fatal(err)
	}
	sqlite := store.(*sqliteStore)
	if _, err := sqlite.db.Exec(`UPDATE action_events SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')`); err != nil {
		t.Fatal(err)
	}
	events, err := store.GetActionEvents(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("expired events = %v", events)
	}
}

func TestMigrationIdempotentWithMainWorktreeBranch(t *testing.T) {
	dir := t.TempDir()

	s1, err := Open(dir)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	if err := s1.SetBranch("app-f", "main"); err != nil {
		t.Fatalf("SetBranch: %v", err)
	}
	if err := s1.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}

	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer s2.Close()

	// Set MainWorktreeBranch on the re-opened store.
	if err := s2.SetMainWorktreeBranch("app-f", "main"); err != nil {
		t.Fatalf("SetMainWorktreeBranch after re-open: %v", err)
	}

	st, err := s2.GetAppState("app-f")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if st.Branch != "main" {
		t.Fatalf("Branch not preserved: got %q", st.Branch)
	}
	if st.MainWorktreeBranch != "main" {
		t.Fatalf("MainWorktreeBranch: got %q, want %q", st.MainWorktreeBranch, "main")
	}
}

// TestCloseIsIdempotentError verifies that Close does not panic; a second call
// may return an error but must not panic.
func TestScriptArgsHistoryRoundTrip(t *testing.T) {
	s := openTemp(t)

	script := "test/hello.sh"
	first := map[string]string{"name": "Fabian", "times": "1"}
	second := map[string]string{"name": "Alice", "times": "2"}

	if err := s.AddScriptArgsHistory(script, first, 50); err != nil {
		t.Fatalf("AddScriptArgsHistory first: %v", err)
	}
	if err := s.AddScriptArgsHistory(script, second, 50); err != nil {
		t.Fatalf("AddScriptArgsHistory second: %v", err)
	}

	history, err := s.GetScriptArgsHistory(script, 50)
	if err != nil {
		t.Fatalf("GetScriptArgsHistory: %v", err)
	}
	if len(history) != 2 {
		t.Fatalf("expected 2 history entries, got %d", len(history))
	}
	if history[0]["name"] != "Alice" || history[1]["name"] != "Fabian" {
		t.Fatalf("unexpected history order/content: %+v", history)
	}
}

func TestScriptArgsHistoryTrim(t *testing.T) {
	s := openTemp(t)
	script := "test/trim.sh"

	for i := 0; i < 5; i++ {
		if err := s.AddScriptArgsHistory(script, map[string]string{"i": string(rune('0' + i))}, 3); err != nil {
			t.Fatalf("AddScriptArgsHistory %d: %v", i, err)
		}
	}

	history, err := s.GetScriptArgsHistory(script, 50)
	if err != nil {
		t.Fatalf("GetScriptArgsHistory: %v", err)
	}
	if len(history) != 3 {
		t.Fatalf("expected trimmed history length 3, got %d", len(history))
	}
	if history[0]["i"] != "4" || history[2]["i"] != "2" {
		t.Fatalf("unexpected trimmed history values: %+v", history)
	}
}

func TestDependencyLeasePersistence(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	lease := DependencyLease{TargetID: "dependency/redis/docker/local", OwnerRunID: "run-1", OwnerApp: "api", Lifecycle: "owned", UpdatedAt: "now"}
	if err := store.SetDependencyLease(lease); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	leases, err := store.GetDependencyLeases()
	if err != nil || len(leases) != 1 || leases[0].OwnerRunID != "run-1" {
		t.Fatalf("leases=%#v err=%v", leases, err)
	}
	if err := store.DeleteDependencyLease(lease.TargetID, lease.OwnerRunID); err != nil {
		t.Fatal(err)
	}
	leases, err = store.GetDependencyLeases()
	if err != nil || len(leases) != 0 {
		t.Fatalf("leases after delete=%#v err=%v", leases, err)
	}
}

func TestCloseBehavior(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	// A second Close on a closed *sql.DB returns an error — that is acceptable.
	// What matters is that it does not panic.
	_ = s.Close()
}
