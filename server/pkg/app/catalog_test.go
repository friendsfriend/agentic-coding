package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/friendsfriend/devenv/pkg/state"
)

func writeAppDefinition(t *testing.T, configDir, kind, ident, body string) {
	t.Helper()
	dir := filepath.Join(configDir, kind, "definitions")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, ident+".json"), []byte(body), 0644); err != nil {
		t.Fatalf("write %s definition: %v", ident, err)
	}
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func initGitRepo(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir repo: %v", err)
	}
	runGit(t, dir, "init", "-q", "-b", "main")
	runGit(t, dir, "commit", "-q", "--allow-empty", "-m", "init")
}

func realPath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("EvalSymlinks(%s): %v", path, err)
	}
	return resolved
}

func TestBuildProjectCatalogEmpty(t *testing.T) {
	projects, err := BuildProjectCatalog(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(projects) != 0 {
		t.Fatalf("expected empty catalog, got %#v", projects)
	}
	if revision := CatalogRevision(projects); revision == "" {
		t.Fatalf("expected a stable revision for an empty catalog")
	}
}

func TestBuildProjectCatalogDuplicateIdent(t *testing.T) {
	_, err := BuildProjectCatalog([]App{
		{Ident: "shared", DisplayName: "App", AppType: TypeAPP},
		{Ident: "shared", DisplayName: "Library", AppType: TypeLIB},
	})
	if err == nil {
		t.Fatalf("expected duplicate ident to be rejected")
	}
}

func TestProjectCatalogCanonicalRootAndCapabilities(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()
	writeAppDefinition(t, configDir, "apps", "checkout-app", `{"ident":"checkout-app","displayName":"Checkout App"}`)
	writeAppDefinition(t, configDir, "libraries", "shared-lib", `{"ident":"shared-lib","displayName":"Shared Lib"}`)

	repoDir := filepath.Join(homeDir, "checkout-app", "checkout-app")
	initGitRepo(t, repoDir)
	if err := os.MkdirAll(filepath.Join(repoDir, "openspec"), 0755); err != nil {
		t.Fatalf("mkdir openspec: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "openspec", "config.yaml"), []byte("schema: spec-driven\n"), 0644); err != nil {
		t.Fatalf("write openspec config: %v", err)
	}
	// The library is available but has no OpenSpec configuration.
	initGitRepo(t, filepath.Join(homeDir, "shared-lib", "shared-lib"))
	// The uncloned library is intentionally never cloned.
	writeAppDefinition(t, configDir, "libraries", "uncloned-lib", `{"ident":"uncloned-lib","displayName":"Uncloned Lib"}`)

	mgr := NewManager(homeDir, configDir, nil)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	projects, err := mgr.GetProjectCatalog()
	if err != nil {
		t.Fatalf("GetProjectCatalog: %v", err)
	}
	byIdent := map[string]Project{}
	for _, p := range projects {
		byIdent[p.Ident] = p
	}

	app := byIdent["checkout-app"]
	if app.Kind != ProjectKindApp || !app.Available || app.Availability != ProjectAvailable {
		t.Fatalf("unexpected app projection: %#v", app)
	}
	if app.CanonicalRoot != realPath(t, repoDir) {
		t.Fatalf("canonical root = %q, want %q", app.CanonicalRoot, repoDir)
	}
	if !app.Capabilities.OpenSpec {
		t.Fatalf("expected OpenSpec capability for checkout-app")
	}

	lib := byIdent["shared-lib"]
	if lib.Kind != ProjectKindLibrary || !lib.Available {
		t.Fatalf("unexpected library projection: %#v", lib)
	}
	if lib.Capabilities.OpenSpec {
		t.Fatalf("library without openspec config must not report the capability: %#v", lib)
	}

	uncloned := byIdent["uncloned-lib"]
	if uncloned.Available || uncloned.Availability != ProjectMissing {
		t.Fatalf("uncloned project should be missing: %#v", uncloned)
	}
	if uncloned.Ident == "" || uncloned.ActiveCheckout == "" {
		t.Fatalf("uncloned project must retain identity and managed location: %#v", uncloned)
	}

	first := NewProjectCatalog(projects).Revision
	second := NewProjectCatalog(projects).Revision
	if first == "" || first != second {
		t.Fatalf("revision must be stable: %q vs %q", first, second)
	}
}

func TestProjectCatalogInvalidRepo(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()
	writeAppDefinition(t, configDir, "apps", "not-a-repo", `{"ident":"not-a-repo","displayName":"Not A Repo"}`)

	dir := filepath.Join(homeDir, "not-a-repo", "not-a-repo")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	mgr := NewManager(homeDir, configDir, nil)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	projects, err := mgr.GetProjectCatalog()
	if err != nil {
		t.Fatalf("GetProjectCatalog: %v", err)
	}
	if len(projects) != 1 {
		t.Fatalf("expected 1 project, got %d", len(projects))
	}
	if projects[0].Available || projects[0].Availability != ProjectInvalid {
		t.Fatalf("expected invalid availability: %#v", projects[0])
	}
}

func TestLoadCatalogConfigDoesNotRefreshOrPersistBranch(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()
	dbDir := filepath.Join(homeDir, "db")
	writeAppDefinition(t, configDir, "apps", "readonly-app", `{"ident":"readonly-app","displayName":"Read Only"}`)
	initGitRepo(t, filepath.Join(homeDir, "readonly-app", "readonly-app"))

	store, err := state.Open(dbDir)
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	defer store.Close()
	// Seed a stored branch that differs from the actual git HEAD (main).
	if err := store.SetAppState(state.AppState{Ident: "readonly-app", Branch: "stored-branch"}); err != nil {
		t.Fatalf("SetAppState: %v", err)
	}

	mgr := NewManager(homeDir, configDir, store)
	if err := mgr.LoadCatalogConfig(); err != nil {
		t.Fatalf("LoadCatalogConfig: %v", err)
	}

	stored, err := store.GetAppState("readonly-app")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if stored.Branch != "stored-branch" {
		t.Fatalf("catalog load persisted a refreshed branch: %q", stored.Branch)
	}
}

func TestProjectCatalogLinkedWorktreeSharesCanonicalRoot(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()
	dbDir := filepath.Join(homeDir, "db")
	writeAppDefinition(t, configDir, "apps", "wt-app", `{"ident":"wt-app","displayName":"WT App","gitMode":"WORKTREE"}`)

	primary := filepath.Join(homeDir, "wt-app", "wt-app")
	initGitRepo(t, primary)
	linked := filepath.Join(homeDir, "wt-app", "wt-app.feature-x")
	runGit(t, primary, "worktree", "add", "-q", "-b", "feature-x", linked)

	store, err := state.Open(dbDir)
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	defer store.Close()
	if err := store.SetAppState(state.AppState{
		Ident:              "wt-app",
		Branch:             "feature-x",
		ActiveWorktree:     "feature-x",
		MainWorktreeBranch: "main",
	}); err != nil {
		t.Fatalf("SetAppState: %v", err)
	}

	mgr := NewManager(homeDir, configDir, store)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	projects, err := mgr.GetProjectCatalog()
	if err != nil {
		t.Fatalf("GetProjectCatalog: %v", err)
	}
	if len(projects) != 1 {
		t.Fatalf("expected 1 project, got %d", len(projects))
	}
	project := projects[0]
	if project.ActiveCheckout != linked {
		t.Fatalf("active checkout = %q, want linked worktree %q", project.ActiveCheckout, linked)
	}
	if project.CanonicalRoot != realPath(t, primary) {
		t.Fatalf("canonical root = %q, want primary repository %q", project.CanonicalRoot, primary)
	}
	if !project.Available {
		t.Fatalf("linked worktree should be available: %#v", project)
	}
}
