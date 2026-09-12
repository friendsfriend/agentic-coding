// Package state manages runtime/local storage data that changes during
// application operation (current branch, active worktree, etc.).
//
// This is intentionally separate from the configuration layer
// (~/.config/devenv) which is static, human-edited and version-controllable.
// State lives in $DEVENV_HOME/db/state.db (a SQLite database).
package state

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver
)

const schemaVersion = 7

// AppState holds the mutable runtime state for a single application.
type AppState struct {
	// Ident is the application identifier (matches app config ident).
	Ident string
	// Branch is the currently checked-out git branch.
	Branch string
	// ActiveWorktree is the branch/name of the currently active worktree
	// (only meaningful when the app is in worktree mode).
	ActiveWorktree string
	// MainWorktreeBranch is the branch that was checked out in the primary
	// worktree when it was first cloned.  It is discovered at clone time and
	// must never be written to the static config JSON files.
	MainWorktreeBranch string
}

// AppRunTargetInfo holds persisted app run target metadata.
type AppRunTargetInfo struct {
	Runtime    string
	LaunchMode string
	Label      string
	Profile    string
	TargetID   string
	SourcePath string
	StartedAt  string
	Display    string
}

type DependencyLease struct {
	TargetID   string
	OwnerRunID string
	OwnerApp   string
	Lifecycle  string
	UpdatedAt  string
}

// Store provides read/write access to the runtime state database.
type Store interface {
	// GetAppState returns the stored runtime state for an app.
	// If no state has been recorded yet, a zero-value AppState is returned
	// (not an error).
	GetAppState(ident string) (AppState, error)

	// SetBranch persists the current branch for an app.
	SetBranch(ident, branch string) error

	// SetActiveWorktree persists the active worktree for an app.
	SetActiveWorktree(ident, worktree string) error

	// SetMainWorktreeBranch persists the branch of the primary worktree.
	// This is called once after the initial clone when the actual branch is
	// known (the remote may have redirected from the requested branch to its
	// default branch).
	SetMainWorktreeBranch(ident, branch string) error

	// SetAppState upserts branch, active worktree, and main worktree branch at once.
	SetAppState(s AppState) error

	// GetAppRunTargetInfo returns persisted run target info for an app.
	GetAppRunTargetInfo(ident string) (AppRunTargetInfo, bool, error)

	// SetAppRunTargetInfo persists run target info for an app.
	SetAppRunTargetInfo(ident string, info AppRunTargetInfo) error

	// ClearAppRunTargetInfo clears persisted run target info for an app.
	ClearAppRunTargetInfo(ident string) error
	GetDependencyLeases() ([]DependencyLease, error)
	SetDependencyLease(lease DependencyLease) error
	DeleteDependencyLease(targetID, ownerRunID string) error

	// GetScriptArgsHistory returns newest-first script argument entries for a script path.
	GetScriptArgsHistory(relativePath string, limit int) ([]map[string]string, error)

	// AddScriptArgsHistory inserts one script argument entry and trims history to maxEntries.
	AddScriptArgsHistory(relativePath string, values map[string]string, maxEntries int) error

	// AddActionEvent appends a serialized action lifecycle event and trims oldest events.
	AddActionEvent(eventJSON string, maxEntries int) error

	// GetActionEvents returns serialized action lifecycle events oldest first.
	GetActionEvents(limit int) ([]string, error)

	// GetActionEventsSince returns serialized action events created at or after since.
	GetActionEventsSince(limit int, since time.Time) ([]string, error)

	// GetActionEventsBetween returns serialized action events created in [since, before).
	GetActionEventsBetween(limit int, since, before time.Time) ([]string, error)

	// AddActionLogEvent appends output for an action step and trims oldest logs.
	AddActionLogEvent(runID, stepID, eventJSON string, maxEntries int) error

	// GetActionLogEvents returns serialized output events for one action or step, oldest first.
	GetActionLogEvents(runID, stepID string, limit int) ([]string, error)

	// Close releases database resources.
	Close() error
}

type sqliteStore struct {
	mu sync.Mutex
	db *sql.DB
}

// Open opens (or creates) the SQLite state database at dbDir/state.db.
// dbDir is created if it does not exist.
func Open(dbDir string) (Store, error) {
	if err := os.MkdirAll(dbDir, 0755); err != nil {
		return nil, fmt.Errorf("state: failed to create db directory %q: %w", dbDir, err)
	}

	dbPath := filepath.Join(dbDir, "state.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("state: failed to open database %q: %w", dbPath, err)
	}

	// SQLite performs best with a single writer connection.
	db.SetMaxOpenConns(1)

	s := &sqliteStore{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("state: schema migration failed: %w", err)
	}
	return s, nil
}

// migrate applies all outstanding schema migrations in order.
func (s *sqliteStore) migrate() error {
	// Enable WAL mode for better read/write concurrency.
	if _, err := s.db.Exec(`PRAGMA journal_mode=WAL`); err != nil {
		return fmt.Errorf("enabling WAL mode: %w", err)
	}
	if _, err := s.db.Exec(`PRAGMA foreign_keys=ON`); err != nil {
		return fmt.Errorf("enabling foreign keys: %w", err)
	}

	// Metadata table to track the applied schema version.
	if _, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_meta (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`); err != nil {
		return fmt.Errorf("creating schema_meta: %w", err)
	}

	var current int
	row := s.db.QueryRow(`SELECT value FROM schema_meta WHERE key = 'version'`)
	_ = row.Scan(&current) // ignore "no rows" – current stays 0

	if current < 1 {
		if err := s.applyV1(); err != nil {
			return err
		}
		current = 1
	}

	if current < 2 {
		if err := s.applyV2(); err != nil {
			return err
		}
		current = 2
	}

	if current < 3 {
		if err := s.applyV3(); err != nil {
			return err
		}
		current = 3
	}

	if current < 4 {
		if err := s.applyV4(); err != nil {
			return err
		}
		current = 4
	}

	if current < 5 {
		if err := s.applyV5(); err != nil {
			return err
		}
		current = 5
	}
	if current < 6 {
		if err := s.applyV6(); err != nil {
			return err
		}
		current = 6
	}
	if current < 7 {
		if err := s.applyV7(); err != nil {
			return err
		}
		current = 7
	}

	if _, err := s.db.Exec(`
		INSERT INTO schema_meta (key, value) VALUES ('version', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value
	`, fmt.Sprintf("%d", current)); err != nil {
		return fmt.Errorf("updating schema version: %w", err)
	}

	return nil
}

// applyV1 creates the initial schema (version 1).
func (s *sqliteStore) applyV1() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS app_state (
			ident           TEXT PRIMARY KEY,
			branch          TEXT NOT NULL DEFAULT '',
			active_worktree TEXT NOT NULL DEFAULT '',
			updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
		)
	`)
	if err != nil {
		return fmt.Errorf("creating app_state table: %w", err)
	}
	return nil
}

// applyV2 adds the main_worktree_branch column introduced when MainWorktreeBranch
// was moved from the static config JSON into the SQLite runtime state.
func (s *sqliteStore) applyV2() error {
	_, err := s.db.Exec(`
		ALTER TABLE app_state
		ADD COLUMN main_worktree_branch TEXT NOT NULL DEFAULT ''
	`)
	if err != nil {
		return fmt.Errorf("adding main_worktree_branch column: %w", err)
	}
	return nil
}

// applyV3 creates script argument history storage.
func (s *sqliteStore) applyV3() error {
	if _, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS script_args_history (
			id                   INTEGER PRIMARY KEY AUTOINCREMENT,
			script_relative_path TEXT NOT NULL,
			args_json            TEXT NOT NULL,
			created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
		)
	`); err != nil {
		return fmt.Errorf("creating script_args_history table: %w", err)
	}
	if _, err := s.db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_script_args_history_path_id
		ON script_args_history(script_relative_path, id DESC)
	`); err != nil {
		return fmt.Errorf("creating script_args_history index: %w", err)
	}
	return nil
}

// applyV4 adds persisted app run target metadata.
func (s *sqliteStore) applyV7() error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin action log migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`
		CREATE TABLE IF NOT EXISTS action_log_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id TEXT NOT NULL,
			step_id TEXT NOT NULL,
			event_json TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		CREATE INDEX IF NOT EXISTS idx_action_log_events_run_step_id ON action_log_events(run_id, step_id, id);
	`); err != nil {
		return fmt.Errorf("creating action_log_events table: %w", err)
	}
	rows, err := tx.Query(`SELECT id, event_json, created_at FROM action_events ORDER BY id`)
	if err != nil {
		return fmt.Errorf("reading action events for log migration: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var payload, createdAt string
		if err := rows.Scan(&id, &payload, &createdAt); err != nil {
			return fmt.Errorf("scanning action event for log migration: %w", err)
		}
		var event struct {
			Type       string `json:"type"`
			Properties struct {
				RunID  string `json:"runId"`
				StepID string `json:"stepId"`
			} `json:"properties"`
		}
		if json.Unmarshal([]byte(payload), &event) != nil || (event.Type != "action.command.output" && event.Type != "action.step.output") || event.Properties.RunID == "" || event.Properties.StepID == "" {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO action_log_events (run_id, step_id, event_json, created_at) VALUES (?, ?, ?, ?)`, event.Properties.RunID, event.Properties.StepID, payload, createdAt); err != nil {
			return fmt.Errorf("migrating action log event: %w", err)
		}
		if _, err := tx.Exec(`DELETE FROM action_events WHERE id = ?`, id); err != nil {
			return fmt.Errorf("removing migrated action log event: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterating action events for log migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit action log migration: %w", err)
	}
	return nil
}

func (s *sqliteStore) applyV6() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS dependency_leases (target_id TEXT NOT NULL, owner_run_id TEXT NOT NULL, owner_app TEXT NOT NULL, lifecycle TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(target_id, owner_run_id))`)
	if err != nil {
		return fmt.Errorf("creating dependency_leases table: %w", err)
	}
	return nil
}

func (s *sqliteStore) applyV5() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS action_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_json TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		CREATE INDEX IF NOT EXISTS idx_action_events_id ON action_events(id);
	`)
	if err != nil {
		return fmt.Errorf("creating action_events table: %w", err)
	}
	return nil
}

func (s *sqliteStore) applyV4() error {
	columns := []string{
		"run_target_runtime TEXT NOT NULL DEFAULT ''",
		"run_target_launch_mode TEXT NOT NULL DEFAULT ''",
		"run_target_label TEXT NOT NULL DEFAULT ''",
		"run_target_profile TEXT NOT NULL DEFAULT ''",
		"run_target_id TEXT NOT NULL DEFAULT ''",
		"run_target_source_path TEXT NOT NULL DEFAULT ''",
		"run_target_started_at TEXT NOT NULL DEFAULT ''",
		"run_target_display TEXT NOT NULL DEFAULT ''",
	}
	for _, column := range columns {
		if _, err := s.db.Exec(`ALTER TABLE app_state ADD COLUMN ` + column); err != nil {
			return fmt.Errorf("adding app run target column %q: %w", column, err)
		}
	}
	return nil
}

func (s *sqliteStore) GetAppState(ident string) (AppState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var st AppState
	st.Ident = ident
	row := s.db.QueryRow(
		`SELECT branch, active_worktree, main_worktree_branch FROM app_state WHERE ident = ?`, ident,
	)
	err := row.Scan(&st.Branch, &st.ActiveWorktree, &st.MainWorktreeBranch)
	if err == sql.ErrNoRows {
		return st, nil // no stored state yet is fine
	}
	if err != nil {
		return st, fmt.Errorf("state: GetAppState(%q): %w", ident, err)
	}
	return st, nil
}

func (s *sqliteStore) SetBranch(ident, branch string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch)
		VALUES (?, ?, '', '')
		ON CONFLICT(ident) DO UPDATE SET
			branch     = excluded.branch,
			updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
	`, ident, branch)
	if err != nil {
		return fmt.Errorf("state: SetBranch(%q, %q): %w", ident, branch, err)
	}
	return nil
}

func (s *sqliteStore) SetActiveWorktree(ident, worktree string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch)
		VALUES (?, '', ?, '')
		ON CONFLICT(ident) DO UPDATE SET
			active_worktree = excluded.active_worktree,
			updated_at      = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
	`, ident, worktree)
	if err != nil {
		return fmt.Errorf("state: SetActiveWorktree(%q, %q): %w", ident, worktree, err)
	}
	return nil
}

func (s *sqliteStore) SetMainWorktreeBranch(ident, branch string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch)
		VALUES (?, '', '', ?)
		ON CONFLICT(ident) DO UPDATE SET
			main_worktree_branch = excluded.main_worktree_branch,
			updated_at           = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
	`, ident, branch)
	if err != nil {
		return fmt.Errorf("state: SetMainWorktreeBranch(%q, %q): %w", ident, branch, err)
	}
	return nil
}

func (s *sqliteStore) SetAppState(st AppState) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		INSERT INTO app_state (ident, branch, active_worktree, main_worktree_branch)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(ident) DO UPDATE SET
			branch               = excluded.branch,
			active_worktree      = excluded.active_worktree,
			main_worktree_branch = excluded.main_worktree_branch,
			updated_at           = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
	`, st.Ident, st.Branch, st.ActiveWorktree, st.MainWorktreeBranch)
	if err != nil {
		return fmt.Errorf("state: SetAppState(%q): %w", st.Ident, err)
	}
	return nil
}

func (s *sqliteStore) GetAppRunTargetInfo(ident string) (AppRunTargetInfo, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var info AppRunTargetInfo
	row := s.db.QueryRow(`
		SELECT run_target_runtime, run_target_launch_mode, run_target_label, run_target_profile,
		       run_target_id, run_target_source_path, run_target_started_at, run_target_display
		FROM app_state
		WHERE ident = ?
	`, ident)
	err := row.Scan(&info.Runtime, &info.LaunchMode, &info.Label, &info.Profile, &info.TargetID, &info.SourcePath, &info.StartedAt, &info.Display)
	if err == sql.ErrNoRows {
		return AppRunTargetInfo{}, false, nil
	}
	if err != nil {
		return AppRunTargetInfo{}, false, fmt.Errorf("state: GetAppRunTargetInfo(%q): %w", ident, err)
	}
	if info.Display == "" {
		return AppRunTargetInfo{}, false, nil
	}
	return info, true, nil
}

func (s *sqliteStore) SetAppRunTargetInfo(ident string, info AppRunTargetInfo) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		INSERT INTO app_state (
			ident, branch, active_worktree, main_worktree_branch,
			run_target_runtime, run_target_launch_mode, run_target_label, run_target_profile,
			run_target_id, run_target_source_path, run_target_started_at, run_target_display
		)
		VALUES (?, '', '', '', ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(ident) DO UPDATE SET
			run_target_runtime     = excluded.run_target_runtime,
			run_target_launch_mode = excluded.run_target_launch_mode,
			run_target_label       = excluded.run_target_label,
			run_target_profile     = excluded.run_target_profile,
			run_target_id          = excluded.run_target_id,
			run_target_source_path = excluded.run_target_source_path,
			run_target_started_at  = excluded.run_target_started_at,
			run_target_display     = excluded.run_target_display,
			updated_at             = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
	`, ident, info.Runtime, info.LaunchMode, info.Label, info.Profile, info.TargetID, info.SourcePath, info.StartedAt, info.Display)
	if err != nil {
		return fmt.Errorf("state: SetAppRunTargetInfo(%q): %w", ident, err)
	}
	return nil
}

func (s *sqliteStore) ClearAppRunTargetInfo(ident string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		UPDATE app_state SET
			run_target_runtime = '', run_target_launch_mode = '', run_target_label = '',
			run_target_profile = '', run_target_id = '', run_target_source_path = '',
			run_target_started_at = '', run_target_display = '',
			updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
		WHERE ident = ?
	`, ident)
	if err != nil {
		return fmt.Errorf("state: ClearAppRunTargetInfo(%q): %w", ident, err)
	}
	return nil
}

func (s *sqliteStore) GetScriptArgsHistory(relativePath string, limit int) ([]map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	rows, err := s.db.Query(`
		SELECT args_json
		FROM script_args_history
		WHERE script_relative_path = ?
		ORDER BY id DESC
		LIMIT ?
	`, relativePath, limit)
	if err != nil {
		return nil, fmt.Errorf("state: GetScriptArgsHistory(%q): %w", relativePath, err)
	}
	defer rows.Close()

	history := make([]map[string]string, 0)
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, fmt.Errorf("state: scanning script args history: %w", err)
		}
		values := map[string]string{}
		if err := json.Unmarshal([]byte(raw), &values); err != nil {
			continue
		}
		history = append(history, values)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("state: iterating script args history: %w", err)
	}

	return history, nil
}

func (s *sqliteStore) AddScriptArgsHistory(relativePath string, values map[string]string, maxEntries int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if maxEntries <= 0 {
		maxEntries = 50
	}
	if maxEntries > 200 {
		maxEntries = 200
	}

	payload, err := json.Marshal(values)
	if err != nil {
		return fmt.Errorf("state: marshal script args history for %q: %w", relativePath, err)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("state: begin tx for script args history: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`
		INSERT INTO script_args_history (script_relative_path, args_json)
		VALUES (?, ?)
	`, relativePath, string(payload)); err != nil {
		return fmt.Errorf("state: insert script args history for %q: %w", relativePath, err)
	}

	if _, err := tx.Exec(`
		DELETE FROM script_args_history
		WHERE script_relative_path = ?
		  AND id NOT IN (
			SELECT id FROM script_args_history
			WHERE script_relative_path = ?
			ORDER BY id DESC
			LIMIT ?
		  )
	`, relativePath, relativePath, maxEntries); err != nil {
		return fmt.Errorf("state: trim script args history for %q: %w", relativePath, err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("state: commit script args history for %q: %w", relativePath, err)
	}

	return nil
}

func (s *sqliteStore) AddActionEvent(eventJSON string, maxEntries int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if maxEntries <= 0 {
		maxEntries = 50000
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("state: begin action event tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO action_events (event_json) VALUES (?)`, eventJSON); err != nil {
		return fmt.Errorf("state: insert action event: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM action_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`); err != nil {
		return fmt.Errorf("state: expire action events: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM action_events WHERE id NOT IN (SELECT id FROM action_events ORDER BY id DESC LIMIT ?)`, maxEntries); err != nil {
		return fmt.Errorf("state: trim action events: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("state: commit action event: %w", err)
	}
	return nil
}

func (s *sqliteStore) AddActionLogEvent(runID, stepID, eventJSON string, maxEntries int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if maxEntries <= 0 {
		maxEntries = 50000
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("state: begin action log event tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO action_log_events (run_id, step_id, event_json) VALUES (?, ?, ?)`, runID, stepID, eventJSON); err != nil {
		return fmt.Errorf("state: insert action log event: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM action_log_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`); err != nil {
		return fmt.Errorf("state: expire action log events: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM action_log_events WHERE id NOT IN (SELECT id FROM action_log_events ORDER BY id DESC LIMIT ?)`, maxEntries); err != nil {
		return fmt.Errorf("state: trim action log events: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("state: commit action log event: %w", err)
	}
	return nil
}

func (s *sqliteStore) GetActionLogEvents(runID, stepID string, limit int) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 || limit > 50000 {
		limit = 50000
	}
	if _, err := s.db.Exec(`DELETE FROM action_log_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`); err != nil {
		return nil, fmt.Errorf("state: expire action log events: %w", err)
	}
	query, args := `SELECT event_json FROM (SELECT id, event_json FROM action_log_events WHERE run_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`, []any{runID, limit}
	if stepID != "" {
		query, args = `SELECT event_json FROM (SELECT id, event_json FROM action_log_events WHERE run_id = ? AND step_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`, []any{runID, stepID, limit}
	}
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("state: query action log events: %w", err)
	}
	defer rows.Close()
	var events []string
	for rows.Next() {
		var event string
		if err := rows.Scan(&event); err != nil {
			return nil, fmt.Errorf("state: scan action log event: %w", err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("state: iterate action log events: %w", err)
	}
	return events, nil
}

func (s *sqliteStore) GetActionEventsSince(limit int, since time.Time) ([]string, error) {
	return s.getActionEvents(limit, since, time.Time{})
}

func (s *sqliteStore) GetActionEventsBetween(limit int, since, before time.Time) ([]string, error) {
	return s.getActionEvents(limit, since, before)
}

func (s *sqliteStore) getActionEvents(limit int, since, before time.Time) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 || limit > 50000 {
		limit = 50000
	}
	if _, err := s.db.Exec(`DELETE FROM action_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`); err != nil {
		return nil, fmt.Errorf("state: expire action events: %w", err)
	}
	query := `SELECT event_json FROM (SELECT id, event_json FROM action_events WHERE created_at >= ?`
	args := []any{since.UTC().Format("2006-01-02T15:04:05.000Z")}
	if !before.IsZero() {
		query += ` AND created_at < ?`
		args = append(args, before.UTC().Format("2006-01-02T15:04:05.000Z"))
	}
	query += ` ORDER BY id DESC LIMIT ?) ORDER BY id ASC`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("state: query action events since: %w", err)
	}
	defer rows.Close()
	var events []string
	for rows.Next() {
		var event string
		if err := rows.Scan(&event); err != nil {
			return nil, fmt.Errorf("state: scan action event since: %w", err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("state: iterate action events since: %w", err)
	}
	return events, nil
}

func (s *sqliteStore) GetActionEvents(limit int) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 || limit > 50000 {
		limit = 50000
	}
	if _, err := s.db.Exec(`DELETE FROM action_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`); err != nil {
		return nil, fmt.Errorf("state: expire action events: %w", err)
	}
	rows, err := s.db.Query(`SELECT event_json FROM (SELECT id, event_json FROM action_events ORDER BY id DESC LIMIT ?) ORDER BY id ASC`, limit)
	if err != nil {
		return nil, fmt.Errorf("state: query action events: %w", err)
	}
	defer rows.Close()
	var events []string
	for rows.Next() {
		var event string
		if err := rows.Scan(&event); err != nil {
			return nil, fmt.Errorf("state: scan action event: %w", err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("state: iterate action events: %w", err)
	}
	return events, nil
}

func (s *sqliteStore) GetDependencyLeases() ([]DependencyLease, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT target_id, owner_run_id, owner_app, lifecycle, updated_at FROM dependency_leases`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var leases []DependencyLease
	for rows.Next() {
		var l DependencyLease
		if err := rows.Scan(&l.TargetID, &l.OwnerRunID, &l.OwnerApp, &l.Lifecycle, &l.UpdatedAt); err != nil {
			return nil, err
		}
		leases = append(leases, l)
	}
	return leases, rows.Err()
}
func (s *sqliteStore) SetDependencyLease(lease DependencyLease) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT INTO dependency_leases(target_id,owner_run_id,owner_app,lifecycle,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(target_id, owner_run_id) DO UPDATE SET owner_app=excluded.owner_app, lifecycle=excluded.lifecycle, updated_at=excluded.updated_at`, lease.TargetID, lease.OwnerRunID, lease.OwnerApp, lease.Lifecycle, lease.UpdatedAt)
	return err
}
func (s *sqliteStore) DeleteDependencyLease(targetID, ownerRunID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM dependency_leases WHERE target_id=? AND owner_run_id=?`, targetID, ownerRunID)
	return err
}

func (s *sqliteStore) Close() error {
	return s.db.Close()
}
