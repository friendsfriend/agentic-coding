package state

// Cross-runtime fixture generator.
//
// `port-project-catalog-and-state-to-bun` (task 1.2) requires Go-created
// SQLite fixtures for every supported migration version so the Bun owner can
// prove it reads, migrates and writes the same values. The fixtures are
// checked in under `agentic-coding/test/fixtures/environment/<name>/` as a
// `state.db` plus the `expected.json` contract the Bun test asserts against.
//
// Regenerate with:
//
//	DEVENV_ENV_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/environment \
//	  go test ./pkg/state -run TestWriteEnvironmentFixtures
//
// Without the env var the generator is skipped, so the normal `go test ./...`
// run never writes into the repository.
import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// Expected mirrors the `expected.json` contract of one fixture. It is written
// from the same values the fixture inserts, so the Bun test can assert exact
// round-tripped content instead of re-deriving it.
type fixtureExpectation struct {
	SchemaVersion   int                            `json:"schemaVersion"`
	Apps            []fixtureApp                   `json:"apps"`
	ScriptHistory   map[string][]map[string]string `json:"scriptHistory"`
	ActionEvents    []string                       `json:"actionEvents"`
	ActionLogEvents map[string][]string            `json:"actionLogEvents"`
	DependencyLease []fixtureLease                 `json:"dependencyLeases"`
	Note            string                         `json:"note,omitempty"`
}

type fixtureRunTarget struct {
	Runtime    string `json:"runtime"`
	LaunchMode string `json:"launchMode"`
	Label      string `json:"label"`
	Profile    string `json:"profile"`
	TargetID   string `json:"targetId"`
	SourcePath string `json:"sourcePath"`
	StartedAt  string `json:"startedAt"`
	Display    string `json:"display"`
}

type fixtureApp struct {
	Ident              string            `json:"ident"`
	Branch             string            `json:"branch"`
	ActiveWorktree     string            `json:"activeWorktree"`
	MainWorktreeBranch string            `json:"mainWorktreeBranch"`
	RunTarget          *fixtureRunTarget `json:"runTarget"`
}

type fixtureLease struct {
	TargetID   string `json:"targetId"`
	OwnerRunID string `json:"ownerRunId"`
	OwnerApp   string `json:"ownerApp"`
	Lifecycle  string `json:"lifecycle"`
	UpdatedAt  string `json:"updatedAt"`
}

func TestWriteEnvironmentFixtures(t *testing.T) {
	dir := os.Getenv("DEVENV_ENV_FIXTURE_DIR")
	if dir == "" {
		t.Skip("DEVENV_ENV_FIXTURE_DIR not set")
	}
	builders := []struct {
		name  string
		build func(t *testing.T, dbPath string) fixtureExpectation
	}{
		{"v1", buildV1},
		{"v3", buildV3},
		{"v5", buildV5},
		{"v6", buildV6},
		{"current", buildCurrent},
		{"partial-v4", buildPartialV4},
		{"future", buildFuture},
	}
	for _, builder := range builders {
		t.Run(builder.name, func(t *testing.T) {
			target := filepath.Join(dir, builder.name)
			if err := os.MkdirAll(target, 0o755); err != nil {
				t.Fatal(err)
			}
			dbPath := filepath.Join(target, "state.db")
			for _, suffix := range []string{"", "-wal", "-shm"} {
				_ = os.Remove(dbPath + suffix)
			}
			expected := builder.build(t, dbPath)
			data, err := json.MarshalIndent(expected, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(target, "expected.json"), append(data, '\n'), 0o644); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// exec runs one statement at a time: the driver only guarantees single-statement
// Exec calls.
func exec(t *testing.T, db *sql.DB, statements ...string) {
	t.Helper()
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("exec %q: %v", statement, err)
		}
	}
}

func openFixture(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	exec(t, db, "PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON",
		`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
	return db
}

func setVersion(t *testing.T, db *sql.DB, version int) {
	t.Helper()
	exec(t, db, `INSERT INTO schema_meta (key, value) VALUES ('version', '`+strconv.Itoa(version)+`')
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
}

// The migration DDL below mirrors pkg/state/store.go (and its history) so a
// fixture really is the on-disk shape a Go release of that version produced.
var (
	ddlV1 = `CREATE TABLE IF NOT EXISTS app_state (
		ident           TEXT PRIMARY KEY,
		branch          TEXT NOT NULL DEFAULT '',
		active_worktree TEXT NOT NULL DEFAULT '',
		updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	)`
	ddlV2 = `ALTER TABLE app_state ADD COLUMN main_worktree_branch TEXT NOT NULL DEFAULT ''`
	ddlV3 = []string{
		`CREATE TABLE IF NOT EXISTS script_args_history (
			id                   INTEGER PRIMARY KEY AUTOINCREMENT,
			script_relative_path TEXT NOT NULL,
			args_json            TEXT NOT NULL,
			created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_script_args_history_path_id
			ON script_args_history(script_relative_path, id DESC)`,
	}
	ddlV4Columns = []string{
		"run_target_runtime TEXT NOT NULL DEFAULT ''",
		"run_target_launch_mode TEXT NOT NULL DEFAULT ''",
		"run_target_label TEXT NOT NULL DEFAULT ''",
		"run_target_profile TEXT NOT NULL DEFAULT ''",
		"run_target_id TEXT NOT NULL DEFAULT ''",
		"run_target_source_path TEXT NOT NULL DEFAULT ''",
		"run_target_started_at TEXT NOT NULL DEFAULT ''",
		"run_target_display TEXT NOT NULL DEFAULT ''",
	}
	ddlV5 = []string{
		`CREATE TABLE IF NOT EXISTS action_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_json TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_action_events_id ON action_events(id)`,
	}
	ddlV6 = `CREATE TABLE IF NOT EXISTS dependency_leases (target_id TEXT NOT NULL, owner_run_id TEXT NOT NULL, owner_app TEXT NOT NULL, lifecycle TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(target_id, owner_run_id))`
)

func throughV2(t *testing.T, db *sql.DB) {
	t.Helper()
	exec(t, db, ddlV1, ddlV2)
}

func throughV3(t *testing.T, db *sql.DB) {
	t.Helper()
	throughV2(t, db)
	exec(t, db, ddlV3...)
}

func throughV4(t *testing.T, db *sql.DB) {
	t.Helper()
	throughV3(t, db)
	for _, column := range ddlV4Columns {
		exec(t, db, `ALTER TABLE app_state ADD COLUMN `+column)
	}
}

func throughV5(t *testing.T, db *sql.DB) {
	t.Helper()
	throughV4(t, db)
	exec(t, db, ddlV5...)
}

// throughV6 is the shared v6 seed used by both the v6 fixture and the current
// (Go-migrated) fixture.
func throughV6(t *testing.T, db *sql.DB) {
	t.Helper()
	throughV5(t, db)
	exec(t, db, ddlV6)
	exec(t, db,
		`INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch, updated_at)
		 VALUES ('leased-app', 'main', '', '', '2024-04-05T06:07:08Z')`,
		`INSERT INTO dependency_leases (target_id, owner_run_id, owner_app, lifecycle, updated_at)
		 VALUES ('lease:db', 'run-A', 'leased-app', 'owned', '2024-04-05T06:07:08Z')`,
		`INSERT INTO dependency_leases (target_id, owner_run_id, owner_app, lifecycle, updated_at)
		 VALUES ('lease:cache', 'run-A', 'leased-app', 'owned', '2024-04-05T06:07:09Z')`,
		`INSERT INTO action_events (event_json, created_at) VALUES ('`+actionOutputEvent("run-A", "step-a", "alpha")+`', '2024-04-05T06:07:10.000Z')`,
		`INSERT INTO action_events (event_json, created_at) VALUES ('`+actionStepEvent("run-A", "step-b", "beta")+`', '2024-04-05T06:07:10.500Z')`,
		`INSERT INTO action_events (event_json, created_at) VALUES ('`+actionOutputEvent("run-B", "step-c", "gamma")+`', '2024-04-05T06:07:11.000Z')`,
		`INSERT INTO action_events (event_json, created_at) VALUES ('`+lifecycleEvent("run-B", "deploy")+`', '2024-04-05T06:07:11.500Z')`)
	setVersion(t, db, 6)
}

// actionOutputEvent/actionStepEvent are the two event types migration 7 moves
// into action_log_events; lifecycleEvent is the kind that stays behind.
func actionOutputEvent(runID, stepID, text string) string {
	return `{"type":"action.command.output","properties":{"runId":"` + runID + `","stepId":"` + stepID + `","text":"` + text + `"}}`
}

func actionStepEvent(runID, stepID, text string) string {
	return `{"type":"action.step.output","properties":{"runId":"` + runID + `","stepId":"` + stepID + `","text":"` + text + `"}}`
}

func lifecycleEvent(runID, name string) string {
	return `{"type":"action.run.started","properties":{"runId":"` + runID + `","name":"` + name + `"}}`
}

func buildV1(t *testing.T, path string) fixtureExpectation {
	db := openFixture(t, path)
	defer db.Close()
	exec(t, db, ddlV1)
	exec(t, db,
		`INSERT INTO app_state (ident, branch, active_worktree, updated_at)
		 VALUES ('legacy-branch-app', 'release/1.0', 'feature/older', '2024-01-02T03:04:05Z')`)
	setVersion(t, db, 1)
	return fixtureExpectation{
		SchemaVersion: 1,
		Apps: []fixtureApp{{
			Ident:          "legacy-branch-app",
			Branch:         "release/1.0",
			ActiveWorktree: "feature/older",
		}},
		ScriptHistory:   map[string][]map[string]string{},
		ActionEvents:    []string{},
		ActionLogEvents: map[string][]string{},
		DependencyLease: []fixtureLease{},
	}
}

func buildV3(t *testing.T, path string) fixtureExpectation {
	db := openFixture(t, path)
	defer db.Close()
	throughV3(t, db)
	exec(t, db,
		`INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch, updated_at)
		 VALUES ('worktree-app', 'feature/two', 'feature/two', 'main', '2024-02-03T04:05:06Z')`,
		`INSERT INTO script_args_history (script_relative_path, args_json, created_at)
		 VALUES ('scripts/build.sh', '{"target":"first"}', '2024-02-03T04:05:06Z')`,
		`INSERT INTO script_args_history (script_relative_path, args_json, created_at)
		 VALUES ('scripts/build.sh', '{"target":"second"}', '2024-02-03T04:06:06Z')`,
		`INSERT INTO script_args_history (script_relative_path, args_json, created_at)
		 VALUES ('scripts/deploy.sh', '{}', '2024-02-03T04:07:06Z')`)
	setVersion(t, db, 3)
	return fixtureExpectation{
		SchemaVersion: 3,
		Apps: []fixtureApp{{
			Ident:              "worktree-app",
			Branch:             "feature/two",
			ActiveWorktree:     "feature/two",
			MainWorktreeBranch: "main",
		}},
		ScriptHistory: map[string][]map[string]string{
			// Newest first, the ordering GetScriptArgsHistory returns.
			"scripts/build.sh":  {{"target": "second"}, {"target": "first"}},
			"scripts/deploy.sh": {{}},
		},
		ActionEvents:    []string{},
		ActionLogEvents: map[string][]string{},
		DependencyLease: []fixtureLease{},
	}
}

func buildV5(t *testing.T, path string) fixtureExpectation {
	db := openFixture(t, path)
	defer db.Close()
	throughV5(t, db)
	exec(t, db,
		`INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch, run_target_runtime, run_target_launch_mode, run_target_label, run_target_profile, run_target_id, run_target_source_path, run_target_started_at, run_target_display, updated_at)
		 VALUES ('run-target-app', 'main', '', 'main', 'docker', 'compose', 'local', 'dev', 'app:local', '/srv/app', '2024-03-04T05:06:07Z', 'docker:local', '2024-03-04T05:06:07Z')`,
		`INSERT INTO action_events (event_json, created_at) VALUES ('`+lifecycleEvent("run-1", "build")+`', '2024-03-04T05:06:07.100Z')`,
		`INSERT INTO action_events (event_json, created_at) VALUES ('`+actionOutputEvent("run-1", "step-1", "line one")+`', '2024-03-04T05:06:07.200Z')`,
		`INSERT INTO action_events (event_json, created_at) VALUES ('`+actionOutputEvent("run-1", "step-1", "line two")+`', '2024-03-04T05:06:07.300Z')`)
	setVersion(t, db, 5)
	return fixtureExpectation{
		SchemaVersion: 5,
		Apps: []fixtureApp{{
			Ident:              "run-target-app",
			Branch:             "main",
			MainWorktreeBranch: "main",
			RunTarget: &fixtureRunTarget{
				Runtime: "docker", LaunchMode: "compose", Label: "local", Profile: "dev",
				TargetID: "app:local", SourcePath: "/srv/app",
				StartedAt: "2024-03-04T05:06:07Z", Display: "docker:local",
			},
		}},
		ScriptHistory: map[string][]map[string]string{},
		ActionEvents: []string{
			lifecycleEvent("run-1", "build"),
			actionOutputEvent("run-1", "step-1", "line one"),
			actionOutputEvent("run-1", "step-1", "line two"),
		},
		ActionLogEvents: map[string][]string{},
		DependencyLease: []fixtureLease{},
	}
}

func buildV6(t *testing.T, path string) fixtureExpectation {
	db := openFixture(t, path)
	defer db.Close()
	throughV6(t, db)
	return fixtureExpectation{
		SchemaVersion: 6,
		Apps: []fixtureApp{{
			Ident:  "leased-app",
			Branch: "main",
		}},
		ScriptHistory: map[string][]map[string]string{},
		// Pre-migration content: the output events are still in action_events and
		// migration 7 moves them into action_log_events on first open.
		ActionEvents: []string{
			actionOutputEvent("run-A", "step-a", "alpha"),
			actionStepEvent("run-A", "step-b", "beta"),
			actionOutputEvent("run-B", "step-c", "gamma"),
			lifecycleEvent("run-B", "deploy"),
		},
		ActionLogEvents: map[string][]string{},
		DependencyLease: []fixtureLease{
			{TargetID: "lease:cache", OwnerRunID: "run-A", OwnerApp: "leased-app", Lifecycle: "owned", UpdatedAt: "2024-04-05T06:07:09Z"},
			{TargetID: "lease:db", OwnerRunID: "run-A", OwnerApp: "leased-app", Lifecycle: "owned", UpdatedAt: "2024-04-05T06:07:08Z"},
		},
	}
}

// buildCurrent seeds a v6 database and lets the production Go migration bring
// it to the current schema, so the fixture is the real Go migration output.
func buildCurrent(t *testing.T, path string) fixtureExpectation {
	db := openFixture(t, path)
	throughV6(t, db)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := Open(filepath.Dir(path))
	if err != nil {
		t.Fatalf("go migration of the v6 fixture failed: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	return fixtureExpectation{
		SchemaVersion: schemaVersion,
		Apps: []fixtureApp{{
			Ident:  "leased-app",
			Branch: "main",
		}},
		ScriptHistory: map[string][]map[string]string{},
		// Migration 7 moved the output events into action_log_events.
		ActionEvents: []string{
			lifecycleEvent("run-B", "deploy"),
		},
		ActionLogEvents: map[string][]string{
			"run-A": {
				actionOutputEvent("run-A", "step-a", "alpha"),
				actionStepEvent("run-A", "step-b", "beta"),
			},
			"run-B": {actionOutputEvent("run-B", "step-c", "gamma")},
		},
		DependencyLease: []fixtureLease{
			{TargetID: "lease:cache", OwnerRunID: "run-A", OwnerApp: "leased-app", Lifecycle: "owned", UpdatedAt: "2024-04-05T06:07:09Z"},
			{TargetID: "lease:db", OwnerRunID: "run-A", OwnerApp: "leased-app", Lifecycle: "owned", UpdatedAt: "2024-04-05T06:07:08Z"},
		},
	}
}

// buildPartialV4 is a database interrupted after the v4 columns were added but
// before the version row was written: the column set and the recorded version
// disagree. Reopening must finish idempotently or fail closed, never half-write.
func buildPartialV4(t *testing.T, path string) fixtureExpectation {
	db := openFixture(t, path)
	defer db.Close()
	throughV4(t, db)
	exec(t, db,
		`INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch, updated_at)
		 VALUES ('half-migrated-app', 'main', '', 'main', '2024-05-06T07:08:09Z')`)
	setVersion(t, db, 3)
	return fixtureExpectation{
		SchemaVersion: schemaVersion,
		Apps: []fixtureApp{{
			Ident:              "half-migrated-app",
			Branch:             "main",
			MainWorktreeBranch: "main",
		}},
		ScriptHistory:   map[string][]map[string]string{},
		ActionEvents:    []string{},
		ActionLogEvents: map[string][]string{},
		DependencyLease: []fixtureLease{},
		Note:            "interrupted between the v4 ALTER statements and the version write",
	}
}

// buildFuture is a database written by a newer release: fail closed, never
// downgrade or rewrite it.
func buildFuture(t *testing.T, path string) fixtureExpectation {
	db := openFixture(t, path)
	defer db.Close()
	throughV6(t, db)
	exec(t, db,
		`CREATE TABLE IF NOT EXISTS future_only (id INTEGER PRIMARY KEY)`,
		`INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch, updated_at)
		 VALUES ('future-app', 'main', '', '', '2025-01-01T00:00:00Z')`)
	setVersion(t, db, 99)
	return fixtureExpectation{
		SchemaVersion:   99,
		Apps:            []fixtureApp{},
		ScriptHistory:   map[string][]map[string]string{},
		ActionEvents:    []string{},
		ActionLogEvents: map[string][]string{},
		DependencyLease: []fixtureLease{},
		Note:            "unsupported future schema",
	}
}
