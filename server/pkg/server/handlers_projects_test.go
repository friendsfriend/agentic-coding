package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/friendsfriend/devenv/pkg/app"
)

func initCatalogRepo(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir repo: %v", err)
	}
	cmd := exec.Command("git", "init", "-q", "-b", "main", dir)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
}

func TestHandleGetProjects(t *testing.T) {
	repoDir := filepath.Join(t.TempDir(), "checkout-app")
	initCatalogRepo(t, repoDir)

	s := NewServer(0)
	s.apps = []app.App{{
		Ident:              "checkout-app",
		DisplayName:        "Checkout App",
		LocalDirectoryPath: repoDir,
		AppType:            app.TypeAPP,
	}}

	res := httptest.NewRecorder()
	s.handleGetProjects(res, httptest.NewRequest(http.MethodGet, "/api/projects", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}

	var catalog app.ProjectCatalog
	if err := json.Unmarshal(res.Body.Bytes(), &catalog); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if catalog.Revision == "" {
		t.Fatalf("expected a revision, got %#v", catalog)
	}
	if len(catalog.Projects) != 1 || catalog.Projects[0].Ident != "checkout-app" {
		t.Fatalf("unexpected projects: %#v", catalog.Projects)
	}
	if !catalog.Projects[0].Available {
		t.Fatalf("expected available project: %#v", catalog.Projects[0])
	}
}

func TestHandleGetProjectsDuplicateIdentRejected(t *testing.T) {
	s := NewServer(0)
	s.apps = []app.App{
		{Ident: "dup", DisplayName: "App", AppType: app.TypeAPP},
		{Ident: "dup", DisplayName: "Library", AppType: app.TypeLIB},
	}

	res := httptest.NewRecorder()
	s.handleGetProjects(res, httptest.NewRequest(http.MethodGet, "/api/projects", nil))
	if res.Code != http.StatusConflict {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestHandleGetProjectsRejectsNonGet(t *testing.T) {
	s := NewServer(0)
	res := httptest.NewRecorder()
	s.handleGetProjects(res, httptest.NewRequest(http.MethodPost, "/api/projects", nil))
	if res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", res.Code)
	}
}

func TestPublishCatalogRevisionBroadcastsChanges(t *testing.T) {
	s := NewServer(0)
	s.apps = []app.App{{Ident: "alpha", DisplayName: "Alpha", AppType: app.TypeAPP}}
	listener := make(chan Event, 8)
	s.listenerMu.Lock()
	s.listeners[listener] = true
	s.listenerMu.Unlock()

	s.publishCatalogRevision()
	select {
	case event := <-listener:
		if event.Type != "catalog.changed" {
			t.Fatalf("expected catalog.changed, got %s", event.Type)
		}
	default:
		t.Fatalf("expected an initial catalog.changed notification")
	}

	// Re-publishing an unchanged catalog must not notify or lose the revision.
	revision := s.catalogRevision
	s.publishCatalogRevision()
	if s.catalogRevision != revision {
		t.Fatalf("revision changed without a catalog change: %q -> %q", revision, s.catalogRevision)
	}
	select {
	case event := <-listener:
		t.Fatalf("unexpected event for unchanged catalog: %s", event.Type)
	default:
	}

	// Adding a configured project changes the revision and notifies once.
	s.apps = append(s.apps, app.App{Ident: "beta", DisplayName: "Beta", AppType: app.TypeLIB})
	s.publishCatalogRevision()
	if s.catalogRevision == revision {
		t.Fatalf("revision did not change after adding a project")
	}
	select {
	case event := <-listener:
		if event.Type != "catalog.changed" {
			t.Fatalf("expected catalog.changed, got %s", event.Type)
		}
	default:
		t.Fatalf("expected a catalog.changed notification after adding a project")
	}
}

func TestPublishCatalogRevisionKeepsLastGoodOnError(t *testing.T) {
	s := NewServer(0)
	s.apps = []app.App{{Ident: "alpha", DisplayName: "Alpha", AppType: app.TypeAPP}}
	s.publishCatalogRevision()
	good := s.catalogRevision

	listener := make(chan Event, 8)
	s.listenerMu.Lock()
	s.listeners[listener] = true
	s.listenerMu.Unlock()

	// A duplicate configured ident makes the projection fail; the last good
	// revision must survive so a bad reload never looks like an empty catalog
	// and listeners must be told the reload failed.
	s.apps = append(s.apps, app.App{Ident: "alpha", DisplayName: "Dup", AppType: app.TypeLIB})
	s.publishCatalogRevision()
	if s.catalogRevision != good {
		t.Fatalf("revision replaced after a failed projection: %q -> %q", good, s.catalogRevision)
	}
	select {
	case event := <-listener:
		if event.Type != "catalog.error" {
			t.Fatalf("expected catalog.error, got %s", event.Type)
		}
	default:
		t.Fatalf("expected a catalog.error notification after a failed projection")
	}
}
