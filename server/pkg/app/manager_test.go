package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/friendsfriend/devenv/pkg/state"
)

func TestAppJSONCompatibility(t *testing.T) {
	tests := []struct {
		name            string
		app             *App
		rawJSON         string
		wantJSONParts   []string
		avoidJSONParts  []string
		wantApp         *App
		wantRoundTrip   []App
		checkRoundTrips bool
	}{
		{
			name: "existing app serializes expected fields",
			app: &App{
				Ident:              "shop-fe",
				DisplayName:        "Shop Frontend",
				LocalDirectoryPath: "/workspace/shop-fe",
				RepositoryPath:     "git@example.com:team/shop-fe.git",
				Branch:             "main",
				AppType:            TypeAPP,
				ContainerBaseName:  "shop-fe",
			},
			wantApp: &App{
				Ident:              "shop-fe",
				DisplayName:        "Shop Frontend",
				LocalDirectoryPath: "/workspace/shop-fe",
				RepositoryPath:     "git@example.com:team/shop-fe.git",
				Branch:             "main",
				AppType:            TypeAPP,
				ContainerBaseName:  "shop-fe",
			},
		},
		{
			name:    "unknown extra fields unmarshal without error",
			rawJSON: `{"ident":"shop-mw","displayName":"Shop Middleware","unknownField":"ignored","nested":{"enabled":true}}`,
			wantApp: &App{
				Ident:       "shop-mw",
				DisplayName: "Shop Middleware",
			},
		},
		{
			name:    "missing optional fields unmarshal as zero values",
			rawJSON: `{"ident":"shared-lib","displayName":"Shared Library"}`,
			wantApp: &App{
				Ident:       "shared-lib",
				DisplayName: "Shared Library",
			},
		},
		{
			name:            "app type constants are preserved through round trip",
			checkRoundTrips: true,
			wantRoundTrip: []App{
				{Ident: "frontend", AppType: TypeAPP},
				{Ident: "middleware", AppType: TypeAPP},
				{Ident: "library", AppType: TypeLIB},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.checkRoundTrips {
				for _, original := range tt.wantRoundTrip {
					data, err := json.Marshal(original)
					if err != nil {
						t.Fatalf("marshal failed: %v", err)
					}

					var got App
					if err := json.Unmarshal(data, &got); err != nil {
						t.Fatalf("unmarshal failed: %v", err)
					}

					if got.AppType != original.AppType {
						t.Fatalf("app type mismatch after round trip: got %q want %q", got.AppType, original.AppType)
					}
				}

				return
			}

			var (
				data []byte
				err  error
			)

			if tt.app != nil {
				data, err = json.Marshal(tt.app)
				if err != nil {
					t.Fatalf("marshal failed: %v", err)
				}
			} else {
				data = []byte(tt.rawJSON)
			}

			jsonText := string(data)
			for _, part := range tt.wantJSONParts {
				if !strings.Contains(jsonText, part) {
					t.Fatalf("expected JSON %q to contain %q", jsonText, part)
				}
			}

			for _, part := range tt.avoidJSONParts {
				if strings.Contains(jsonText, part) {
					t.Fatalf("expected JSON %q to omit %q", jsonText, part)
				}
			}

			var got App
			if err := json.Unmarshal(data, &got); err != nil {
				t.Fatalf("unmarshal failed: %v", err)
			}

			if tt.wantApp != nil && !reflect.DeepEqual(got, *tt.wantApp) {
				t.Fatalf("unexpected app after JSON round trip: got %+v want %+v", got, *tt.wantApp)
			}
		})
	}
}

func TestExpandInfraConfigPaths(t *testing.T) {
	svc := InfraService{Kubernetes: &KubernetesInfra{ChartPath: "$CONFIG/chart", Values: []string{"${CONFIG}/values.yaml"}}}
	expandInfraConfigPaths(&svc, "/tmp/config")
	if svc.Kubernetes.ChartPath != "/tmp/config/chart" || svc.Kubernetes.Values[0] != "/tmp/config/values.yaml" {
		t.Fatalf("kubernetes paths = %#v", svc.Kubernetes)
	}
}

func TestInfraServiceJSONRoundTrip(t *testing.T) {
	original := InfraService{
		DisplayName:       "Postgres",
		Ident:             "postgres",
		ContainerBaseName: "postgres",
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	jsonStr := string(data)

	for _, want := range []string{`"displayName"`, `"ident"`, `"containerBaseName"`} {
		if !strings.Contains(jsonStr, want) {
			t.Fatalf("expected JSON to contain %s, got: %s", want, jsonStr)
		}
	}
	for _, avoid := range []string{`"DisplayName"`, `"Ident"`, `"ContainerBaseName"`} {
		if strings.Contains(jsonStr, avoid) {
			t.Fatalf("expected JSON to NOT contain PascalCase key %s, got: %s", avoid, jsonStr)
		}
	}

	var got InfraService
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if !reflect.DeepEqual(got, original) {
		t.Fatalf("round trip mismatch: got %+v, want %+v", got, original)
	}
}

func TestLoadConfigFromSplitFiles(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()

	if err := os.MkdirAll(configDir+"/apps/definitions", 0755); err != nil {
		t.Fatalf("failed to create apps directory: %v", err)
	}
	if err := os.MkdirAll(configDir+"/libraries/definitions", 0755); err != nil {
		t.Fatalf("failed to create libraries directory: %v", err)
	}
	if err := os.MkdirAll(configDir+"/infrastructure/definitions", 0755); err != nil {
		t.Fatalf("failed to create infrastructure directory: %v", err)
	}

	appA := `{"ident":"split-app-a","displayName":"Split A","localDirectoryPath":"a"}`
	appB := `{"ident":"split-app-b","displayName":"Split B","localDirectoryPath":"b"}`
	if err := os.WriteFile(configDir+"/apps/definitions/split-app-a.json", []byte(appA), 0644); err != nil {
		t.Fatalf("failed to write app file a: %v", err)
	}
	if err := os.WriteFile(configDir+"/libraries/definitions/split-app-b.json", []byte(appB), 0644); err != nil {
		t.Fatalf("failed to write app file b: %v", err)
	}

	infraJSON := `{"displayName":"Redis","ident":"redis","containerBaseName":"redis"}`
	if err := os.WriteFile(configDir+"/infrastructure/definitions/redis.json", []byte(infraJSON), 0644); err != nil {
		t.Fatalf("failed to write infra split file: %v", err)
	}

	mgr := NewManager(homeDir, configDir, nil)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	apps := mgr.GetApps()
	if len(apps) != 2 {
		t.Fatalf("expected 2 apps from split files, got %d", len(apps))
	}

	var appTypeA, appTypeB string
	for _, a := range apps {
		if a.Ident == "split-app-a" {
			appTypeA = a.AppType
		}
		if a.Ident == "split-app-b" {
			appTypeB = a.AppType
		}
	}
	if appTypeA != TypeAPP {
		t.Fatalf("expected split-app-a to be APP, got %q", appTypeA)
	}
	if appTypeB != TypeLIB {
		t.Fatalf("expected split-app-b to be LIB, got %q", appTypeB)
	}

	infra := mgr.GetInfraServices()
	if len(infra) != 1 || infra[0].Ident != "redis" {
		t.Fatalf("unexpected infra services: %+v", infra)
	}
}

func TestAddAppWritesSplitFile(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()

	mgr := NewManager(homeDir, configDir, nil)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	newApp := App{
		Ident:              "new-split-app",
		DisplayName:        "New Split App",
		LocalDirectoryPath: "new-split-app",
		RepositoryPath:     "https://example.com/new-split-app.git",
		Branch:             "main",
		AppType:            TypeAPP,
		ContainerBaseName:  "new-split-app",
	}

	if err := mgr.AddApp(newApp); err != nil {
		t.Fatalf("AddApp failed: %v", err)
	}

	if _, err := os.Stat(configDir + "/apps/definitions/new-split-app.json"); err != nil {
		t.Fatalf("expected split app file to exist: %v", err)
	}

	newLib := App{
		Ident:              "new-split-lib",
		DisplayName:        "New Split Lib",
		LocalDirectoryPath: "new-split-lib",
		RepositoryPath:     "https://example.com/new-split-lib.git",
		Branch:             "main",
		AppType:            TypeLIB,
		ContainerBaseName:  "",
	}

	if err := mgr.AddApp(newLib); err != nil {
		t.Fatalf("AddApp (library) failed: %v", err)
	}

	if _, err := os.Stat(configDir + "/libraries/definitions/new-split-lib.json"); err != nil {
		t.Fatalf("expected split library file to exist: %v", err)
	}
}

func TestAddWorktreeAppPersistsInitialRuntimeState(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()

	store, err := state.Open(filepath.Join(homeDir, "db"))
	if err != nil {
		t.Fatalf("Open state store: %v", err)
	}
	defer store.Close()

	mgr := NewManager(homeDir, configDir, store)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig before AddApp: %v", err)
	}

	newApp := App{
		Ident:              "new-worktree-app",
		DisplayName:        "New Worktree App",
		RepositoryPath:     "https://example.com/new-worktree-app.git",
		Branch:             "develop",
		ActiveWorktree:     "develop",
		MainWorktreeBranch: "develop",
		AppType:            TypeAPP,
		GitMode:            GitModeWorktree,
	}
	if err := mgr.AddApp(newApp); err != nil {
		t.Fatalf("AddApp: %v", err)
	}

	st, err := store.GetAppState("new-worktree-app")
	if err != nil {
		t.Fatalf("GetAppState: %v", err)
	}
	if st.Branch != "develop" || st.ActiveWorktree != "develop" || st.MainWorktreeBranch != "develop" {
		t.Fatalf("unexpected persisted state: %+v", st)
	}

	data, err := os.ReadFile(filepath.Join(configDir, "apps", "definitions", "new-worktree-app.json"))
	if err != nil {
		t.Fatalf("Read app file: %v", err)
	}
	for _, forbidden := range []string{"branch", "activeWorktree", "mainWorktreeBranch", "localDirectoryPath"} {
		if strings.Contains(string(data), forbidden) {
			t.Fatalf("app file contains runtime field %q: %s", forbidden, data)
		}
	}

	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig after AddApp: %v", err)
	}
	reloaded, ok := mgr.GetAppByIdent("new-worktree-app")
	if !ok {
		t.Fatal("new app missing after reload")
	}
	if reloaded.Branch != "develop" || reloaded.ActiveWorktree != "develop" || reloaded.MainWorktreeBranch != "develop" {
		t.Fatalf("unexpected reloaded app state: %+v", reloaded)
	}
}

func TestRemoveAppDeletesSplitFile(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()

	if err := os.MkdirAll(configDir+"/apps/definitions", 0755); err != nil {
		t.Fatalf("failed to create apps directory: %v", err)
	}
	if err := os.MkdirAll(configDir+"/libraries/definitions", 0755); err != nil {
		t.Fatalf("failed to create libraries directory: %v", err)
	}

	appJSON := `{"ident":"to-delete","displayName":"Delete Me","localDirectoryPath":"to-delete"}`
	if err := os.WriteFile(configDir+"/apps/definitions/to-delete.json", []byte(appJSON), 0644); err != nil {
		t.Fatalf("failed to write app file: %v", err)
	}

	mgr := NewManager(homeDir, configDir, nil)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	if err := mgr.RemoveApp("to-delete", false); err != nil {
		t.Fatalf("RemoveApp failed: %v", err)
	}

	if _, err := os.Stat(configDir + "/apps/definitions/to-delete.json"); !os.IsNotExist(err) {
		t.Fatalf("expected app file to be deleted, got err: %v", err)
	}

	libJSON := `{"ident":"lib-to-delete","displayName":"Delete Lib","localDirectoryPath":"lib-to-delete"}`
	if err := os.WriteFile(configDir+"/libraries/definitions/lib-to-delete.json", []byte(libJSON), 0644); err != nil {
		t.Fatalf("failed to write library file: %v", err)
	}

	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig failed after adding library fixture: %v", err)
	}

	if err := mgr.RemoveApp("lib-to-delete", false); err != nil {
		t.Fatalf("RemoveApp (library) failed: %v", err)
	}

	if _, err := os.Stat(configDir + "/libraries/lib-to-delete.json"); !os.IsNotExist(err) {
		t.Fatalf("expected library file to be deleted, got err: %v", err)
	}
}

func TestLoadConfigScriptInfraServices(t *testing.T) {
	tests := []struct {
		name string
		body string
		want InfraService
	}{
		{
			name: "shell only",
			body: `{"displayName":"API Shim","ident":"api-shim","type":"script","shellPath":"scripts/api.sh","cwd":"/tmp/app","args":["--dev"],"env":{"PORT":"8080"}}`,
			want: InfraService{DisplayName: "API Shim", Ident: "api-shim", Type: InfraServiceTypeScript, ShellPath: "scripts/api.sh", Cwd: "/tmp/app", Args: []string{"--dev"}, Env: map[string]string{"PORT": "8080"}, Status: InfraStatusStopped},
		},
		{
			name: "powershell only",
			body: `{"displayName":"Win Shim","ident":"win-shim","type":"script","powerShellPath":"scripts/api.ps1","defaultRunner":"powershell"}`,
			want: InfraService{DisplayName: "Win Shim", Ident: "win-shim", Type: InfraServiceTypeScript, PowerShellPath: "scripts/api.ps1", DefaultRunner: ScriptRunnerPowerShell, Status: InfraStatusStopped},
		},
		{
			name: "dual runner",
			body: `{"displayName":"Dual Shim","ident":"dual-shim","type":"script","shellPath":"scripts/api.sh","powerShellPath":"scripts/api.ps1","defaultRunner":"shell"}`,
			want: InfraService{DisplayName: "Dual Shim", Ident: "dual-shim", Type: InfraServiceTypeScript, ShellPath: "scripts/api.sh", PowerShellPath: "scripts/api.ps1", DefaultRunner: ScriptRunnerShell, Status: InfraStatusStopped},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			homeDir := t.TempDir()
			configDir := t.TempDir()
			if err := os.MkdirAll(filepath.Join(configDir, "infrastructure", "definitions"), 0755); err != nil {
				t.Fatalf("mkdir infra definitions: %v", err)
			}
			if err := os.WriteFile(filepath.Join(configDir, "infrastructure", "definitions", "svc.json"), []byte(tt.body), 0644); err != nil {
				t.Fatalf("write infra file: %v", err)
			}

			mgr := NewManager(homeDir, configDir, nil)
			if err := mgr.LoadConfig(); err != nil {
				t.Fatalf("LoadConfig failed: %v", err)
			}
			got := mgr.GetInfraServices()
			if len(got) != 1 {
				t.Fatalf("expected one service, got %+v", got)
			}
			if !reflect.DeepEqual(got[0], tt.want) {
				t.Fatalf("service = %+v, want %+v", got[0], tt.want)
			}
		})
	}
}

func TestLoadConfigDockerInfraDefaultsType(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(configDir, "infrastructure", "definitions"), 0755); err != nil {
		t.Fatalf("mkdir infra definitions: %v", err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "infrastructure", "definitions", "redis.json"), []byte(`{"displayName":"Redis","ident":"redis","containerBaseName":"redis"}`), 0644); err != nil {
		t.Fatalf("write infra file: %v", err)
	}

	mgr := NewManager(homeDir, configDir, nil)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	infra := mgr.GetInfraServices()
	if len(infra) != 1 || infra[0].Type != InfraServiceTypeDocker || infra[0].ContainerBaseName != "redis" {
		t.Fatalf("unexpected infra services: %+v", infra)
	}
}

func TestLoadConfigInfraFromSplitFiles(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()

	if err := os.MkdirAll(configDir+"/infrastructure/definitions", 0755); err != nil {
		t.Fatalf("failed to create infrastructure directory: %v", err)
	}

	redis := `{"displayName":"Redis","ident":"redis","containerBaseName":"redis"}`
	postgres := `{"displayName":"Postgres","ident":"postgres","containerBaseName":"postgres"}`
	if err := os.WriteFile(configDir+"/infrastructure/definitions/redis.json", []byte(redis), 0644); err != nil {
		t.Fatalf("failed to write redis infra file: %v", err)
	}
	if err := os.WriteFile(configDir+"/infrastructure/definitions/postgres.json", []byte(postgres), 0644); err != nil {
		t.Fatalf("failed to write postgres infra file: %v", err)
	}

	mgr := NewManager(homeDir, configDir, nil)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	infra := mgr.GetInfraServices()
	if len(infra) != 2 {
		t.Fatalf("expected 2 infra services from split files, got %d", len(infra))
	}
}

func TestSaveConfigWritesInfraSplitFiles(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()

	if err := os.MkdirAll(configDir+"/apps/definitions", 0755); err != nil {
		t.Fatalf("failed to create apps directory: %v", err)
	}

	appJSON := `{"ident":"test-app","displayName":"Test","localDirectoryPath":""}`
	if err := os.WriteFile(configDir+"/apps/definitions/test-app.json", []byte(appJSON), 0644); err != nil {
		t.Fatalf("failed to write app file: %v", err)
	}

	mgr := NewManager(homeDir, configDir, nil)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	// Add infra services directly (no public API exists for adding infra).
	am := mgr.(*appManager)
	am.infraServices = []InfraService{
		{DisplayName: "Redis", Ident: "redis", ContainerBaseName: "redis"},
	}

	if err := mgr.SaveConfig(); err != nil {
		t.Fatalf("SaveConfig failed: %v", err)
	}

	if _, err := os.Stat(configDir + "/infrastructure/definitions/redis.json"); err != nil {
		t.Fatalf("expected split infra service file to exist: %v", err)
	}
}

// TestResolveActiveWorktreePath verifies the path resolution invariants for
// worktree-mode apps:
//   - primary dir when active == mainWorktreeBranch
//   - primary dir when active == ""
//   - primary dir when mainWorktreeBranch == "" (legacy / mid-clone guard)
//   - linked worktree dir when active != mainWorktreeBranch (and both non-empty)
func TestResolveActiveWorktreePath(t *testing.T) {
	homeDir := t.TempDir()
	am := &appManager{homeDir: homeDir}

	const ident = "installer-fe"

	// helpers
	primaryDir := func() string {
		return filepath.Join(homeDir, ident, ident)
	}
	linkedDir := func(branch string) string {
		return filepath.Join(homeDir, ident, ident+"."+worktreeBranchToDir(branch))
	}

	tests := []struct {
		name               string
		activeWorktree     string
		mainWorktreeBranch string
		wantPath           string
	}{
		{
			name:               "active == main returns primary dir",
			activeWorktree:     "develop",
			mainWorktreeBranch: "develop",
			wantPath:           primaryDir(),
		},
		{
			name:               "active empty returns primary dir",
			activeWorktree:     "",
			mainWorktreeBranch: "develop",
			wantPath:           primaryDir(),
		},
		{
			name:               "main empty returns primary dir (legacy guard)",
			activeWorktree:     "develop",
			mainWorktreeBranch: "",
			wantPath:           primaryDir(),
		},
		{
			name:               "both empty returns primary dir",
			activeWorktree:     "",
			mainWorktreeBranch: "",
			wantPath:           primaryDir(),
		},
		{
			name:               "active != main returns linked worktree dir",
			activeWorktree:     "feature-xyz",
			mainWorktreeBranch: "develop",
			wantPath:           linkedDir("feature-xyz"),
		},
		{
			name:               "branch with slash is sanitized in linked path",
			activeWorktree:     "feature/my-branch",
			mainWorktreeBranch: "develop",
			wantPath:           linkedDir("feature/my-branch"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.wantPath != primaryDir() {
				if err := os.MkdirAll(tt.wantPath, 0755); err != nil {
					t.Fatalf("mkdir linked worktree: %v", err)
				}
			}

			a := App{
				Ident:              ident,
				GitMode:            GitModeWorktree,
				ActiveWorktree:     tt.activeWorktree,
				MainWorktreeBranch: tt.mainWorktreeBranch,
			}
			got := am.resolveActiveWorktreePath(a)
			if got != tt.wantPath {
				t.Errorf("resolveActiveWorktreePath() = %q, want %q", got, tt.wantPath)
			}
		})
	}
}

// TestLoadConfigWorktreePathResolvesToPrimaryWhenMainBranchUnknown verifies
// that after a LoadConfig where SQLite has main_worktree_branch=” (e.g. a
// legacy app row), LocalDirectoryPath is resolved to the primary worktree
// directory and not a non-existent linked path.
func TestLoadConfigWorktreePathResolvesToPrimaryWhenMainBranchUnknown(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()
	dbDir := filepath.Join(homeDir, "db")

	if err := os.MkdirAll(configDir+"/apps/definitions", 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	appJSON := `{"ident":"wt-app","displayName":"WT App","gitMode":"WORKTREE"}`
	if err := os.WriteFile(configDir+"/apps/definitions/wt-app.json", []byte(appJSON), 0644); err != nil {
		t.Fatalf("write app file: %v", err)
	}

	store, err := state.Open(dbDir)
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	defer store.Close()

	// Simulate a legacy SQLite row: active_worktree is set but main_worktree_branch is empty.
	if err := store.SetActiveWorktree("wt-app", "develop"); err != nil {
		t.Fatalf("SetActiveWorktree: %v", err)
	}
	// main_worktree_branch intentionally NOT set — simulates legacy row with empty value.

	mgr := NewManager(homeDir, configDir, store)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}

	apps := mgr.GetApps()
	if len(apps) != 1 {
		t.Fatalf("expected 1 app, got %d", len(apps))
	}
	got := apps[0].LocalDirectoryPath
	primaryDir := filepath.Join(homeDir, "wt-app", "wt-app")
	if got != primaryDir {
		t.Errorf("LocalDirectoryPath = %q, want primary dir %q (guard for empty MainWorktreeBranch failed)", got, primaryDir)
	}
}

// TestLoadConfigWorktreePathResolvesToPrimaryWhenMainBranchMatches verifies
// that when SQLite has active_worktree == main_worktree_branch, LocalDirectoryPath
// points to the primary worktree directory.
func TestLoadConfigWorktreePathResolvesToPrimaryWhenMainBranchMatches(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()
	dbDir := filepath.Join(homeDir, "db")

	if err := os.MkdirAll(configDir+"/apps/definitions", 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	appJSON := `{"ident":"wt-app2","displayName":"WT App 2","gitMode":"WORKTREE"}`
	if err := os.WriteFile(configDir+"/apps/definitions/wt-app2.json", []byte(appJSON), 0644); err != nil {
		t.Fatalf("write app file: %v", err)
	}

	store, err := state.Open(dbDir)
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	defer store.Close()

	// Seed SQLite: active_worktree == main_worktree_branch == "develop"
	if err := store.SetAppState(state.AppState{
		Ident:              "wt-app2",
		Branch:             "develop",
		ActiveWorktree:     "develop",
		MainWorktreeBranch: "develop",
	}); err != nil {
		t.Fatalf("SetAppState: %v", err)
	}

	mgr := NewManager(homeDir, configDir, store)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}

	apps := mgr.GetApps()
	if len(apps) != 1 {
		t.Fatalf("expected 1 app, got %d", len(apps))
	}
	got := apps[0].LocalDirectoryPath
	primaryDir := filepath.Join(homeDir, "wt-app2", "wt-app2")
	if got != primaryDir {
		t.Errorf("LocalDirectoryPath = %q, want primary dir %q", got, primaryDir)
	}
}

// TestLoadConfigWorktreePathResolvesToLinkedDirForNonMainBranch verifies that
// when the active worktree is a non-main branch, LocalDirectoryPath is the
// linked worktree directory.
func TestLoadConfigWorktreePathResolvesToLinkedDirForNonMainBranch(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()
	dbDir := filepath.Join(homeDir, "db")

	if err := os.MkdirAll(configDir+"/apps/definitions", 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	appJSON := `{"ident":"wt-app3","displayName":"WT App 3","gitMode":"WORKTREE"}`
	if err := os.WriteFile(configDir+"/apps/definitions/wt-app3.json", []byte(appJSON), 0644); err != nil {
		t.Fatalf("write app file: %v", err)
	}

	store, err := state.Open(dbDir)
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	defer store.Close()

	// active_worktree is a feature branch; main_worktree_branch is "develop"
	wantLinkedDir := filepath.Join(homeDir, "wt-app3", "wt-app3.feature-abc")
	if err := os.MkdirAll(wantLinkedDir, 0755); err != nil {
		t.Fatalf("mkdir linked worktree: %v", err)
	}
	if err := store.SetAppState(state.AppState{
		Ident:              "wt-app3",
		Branch:             "feature-abc",
		ActiveWorktree:     "feature-abc",
		MainWorktreeBranch: "develop",
	}); err != nil {
		t.Fatalf("SetAppState: %v", err)
	}

	mgr := NewManager(homeDir, configDir, store)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}

	apps := mgr.GetApps()
	if len(apps) != 1 {
		t.Fatalf("expected 1 app, got %d", len(apps))
	}
	got := apps[0].LocalDirectoryPath
	if got != wantLinkedDir {
		t.Errorf("LocalDirectoryPath = %q, want linked dir %q", got, wantLinkedDir)
	}
}

// TestSetMainWorktreeBranchBeforeReloadConfig verifies the ordering fix: when
// SetMainWorktreeBranch is called before the next LoadConfig (as now guaranteed
// by the handlers_apps.go ordering), resolveActiveWorktreePath sees a matching
// MainWorktreeBranch and routes to the primary worktree directory.
//
// This is the regression test for the bug where reloadAppConfig ran before
// SetMainWorktreeBranch, causing LoadConfig to see MainWorktreeBranch="" and
// route to a non-existent linked worktree path.
func TestSetMainWorktreeBranchBeforeReloadConfig(t *testing.T) {
	homeDir := t.TempDir()
	configDir := t.TempDir()
	dbDir := filepath.Join(homeDir, "db")

	if err := os.MkdirAll(configDir+"/apps/definitions", 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Simulate the JSON config file that handlers_apps.go writes for a new WORKTREE app.
	appJSON := `{"ident":"installer-fe","displayName":"Installer FE","gitMode":"WORKTREE"}`
	if err := os.WriteFile(configDir+"/apps/definitions/installer-fe.json", []byte(appJSON), 0644); err != nil {
		t.Fatalf("write app file: %v", err)
	}

	store, err := state.Open(dbDir)
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	defer store.Close()

	mgr := NewManager(homeDir, configDir, store)

	// Step 1 — AddApp (happens inside the handler, sets in-memory state)
	if err := mgr.AddApp(App{
		Ident:              "installer-fe",
		DisplayName:        "Installer FE",
		RepositoryPath:     "https://example.com/installer-fe.git",
		AppType:            TypeAPP,
		GitMode:            GitModeWorktree,
		ActiveWorktree:     "develop",
		MainWorktreeBranch: "develop",
	}); err != nil {
		t.Fatalf("AddApp: %v", err)
	}

	// Step 2 — SetMainWorktreeBranch (now ordered BEFORE reloadAppConfig)
	if err := mgr.SetMainWorktreeBranch("installer-fe", "develop"); err != nil {
		t.Fatalf("SetMainWorktreeBranch: %v", err)
	}

	// Also set ActiveWorktree in SQLite (simulates what the checkout handler writes)
	if err := store.SetActiveWorktree("installer-fe", "develop"); err != nil {
		t.Fatalf("SetActiveWorktree: %v", err)
	}

	// Step 3 — LoadConfig (simulates reloadAppConfig in the handler)
	if err := mgr.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}

	apps := mgr.GetApps()
	if len(apps) == 0 {
		t.Fatal("expected at least 1 app after LoadConfig")
	}
	var found *App
	for i := range apps {
		if apps[i].Ident == "installer-fe" {
			found = &apps[i]
		}
	}
	if found == nil {
		t.Fatal("installer-fe app not found after LoadConfig")
	}

	// The critical assertion: LocalDirectoryPath must be the PRIMARY worktree,
	// not a linked path like installer-fe.develop.
	primaryDir := filepath.Join(homeDir, "installer-fe", "installer-fe")
	if found.LocalDirectoryPath != primaryDir {
		t.Errorf("LocalDirectoryPath = %q, want primary dir %q\n"+
			"(regression: if MainWorktreeBranch was not seeded before LoadConfig, the path would be %q)",
			found.LocalDirectoryPath, primaryDir,
			filepath.Join(homeDir, "installer-fe", "installer-fe.develop"))
	}
}
