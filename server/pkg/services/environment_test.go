package services

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/friendsfriend/devenv/pkg/environment"
)

// TestOpenEnvironmentLegacyOpensTheLocalDatabase pins the current behavior: the
// Go process owns $DEVENV_HOME/db/state.db while the migration is in progress.
func TestOpenEnvironmentLegacyOpensTheLocalDatabase(t *testing.T) {
	t.Setenv(environment.URLEnvVar, "")
	home := t.TempDir()
	configDir := t.TempDir()

	ownership, err := openEnvironment(home, configDir)
	if err != nil {
		t.Fatalf("openEnvironment: %v", err)
	}
	defer func() { _ = ownership.State.Close() }()
	if ownership.Migrated {
		t.Fatal("expected legacy ownership without an environment URL")
	}
	if err := ownership.State.SetBranch("alpha", "main"); err != nil {
		t.Fatalf("SetBranch: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "db", "state.db")); err != nil {
		t.Fatalf("expected a local state database: %v", err)
	}
}

// TestOpenEnvironmentMigratedHoldsNoWritableHandle is the cutover gate: in
// migrated mode this process must not open the state database at all, so the
// database path is made impossible to open and the environment still works.
func TestOpenEnvironmentMigratedHoldsNoWritableHandle(t *testing.T) {
	home := t.TempDir()
	configDir := t.TempDir()
	// A regular file where the database directory would be: any SQLite open
	// would fail, so a successful startup proves the handle is never taken.
	dbPath := filepath.Join(home, "db")
	if err := os.WriteFile(dbPath, []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != environment.OperationPath {
			http.Error(w, "unexpected path", http.StatusNotFound)
			return
		}
		mu.Lock()
		requests++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "value": nil})
	}))
	defer server.Close()

	t.Setenv(environment.URLEnvVar, server.URL)
	t.Setenv(environment.TokenEnvVar, "private-token")

	ownership, err := openEnvironment(home, configDir)
	if err != nil {
		t.Fatalf("migrated startup must not touch the local database: %v", err)
	}
	defer func() { _ = ownership.State.Close() }()
	if !ownership.Migrated {
		t.Fatal("expected migrated ownership")
	}

	// One logical write reaches the authority exactly once.
	if err := ownership.State.SetBranch("alpha", "main"); err != nil {
		t.Fatalf("SetBranch: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if requests != 1 {
		t.Fatalf("expected exactly one private write, got %d", requests)
	}
	// The local database was not created next to the blocking file.
	if _, err := os.Stat(filepath.Join(home, "db", "state.db")); err == nil {
		t.Fatal("migrated mode must not create a local state database")
	}
}

// TestMaintenanceModesAreExclusive documents the release invariant: the two
// generations never write at the same time.
func TestMaintenanceModesAreExclusive(t *testing.T) {
	for _, testCase := range []struct {
		url      string
		migrated bool
	}{
		{url: "", migrated: false},
		{url: "http://127.0.0.1:4051", migrated: true},
	} {
		t.Setenv(environment.URLEnvVar, testCase.url)
		t.Setenv(environment.TokenEnvVar, "private-token")
		_, migrated := environment.FromEnv()
		if migrated != testCase.migrated {
			t.Fatalf("URL %q: migrated=%v, want %v", testCase.url, migrated, testCase.migrated)
		}
	}
}
