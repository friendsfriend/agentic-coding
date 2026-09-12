package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/friendsfriend/devenv/pkg/state"
)

// Application types
const (
	TypeAPP = "APP"
	TypeLIB = "LIB"
)

// Git modes
const (
	GitModeBranch   = "BRANCH"
	GitModeWorktree = "WORKTREE"
)

// App represents an application.
//
// Static configuration fields (ident, displayName, repositoryPath, etc.) are
// read from the JSON definition files in the config directory and are never
// written back by the running application.
//
// Runtime state fields (Branch, ActiveWorktree, MainWorktreeBranch) are
// tracked in the SQLite state database ($DEVENV_HOME/db/state.db) and must
// not be persisted to the JSON config files.
type App struct {
	// --- static config fields ---
	Ident             string `json:"ident"`
	DisplayName       string `json:"displayName"`
	RepositoryPath    string `json:"repositoryPath"`
	AppType           string `json:"appType"`
	ContainerBaseName string `json:"containerBaseName,omitempty"`
	SourceType        string `json:"sourceType,omitempty"`
	Provider          string `json:"provider,omitempty"`
	GitMode           string `json:"gitMode,omitempty"`

	// --- runtime state fields (from SQLite, not from JSON config) ---
	LocalDirectoryPath string `json:"localDirectoryPath"`
	Branch             string `json:"branch"`
	ActiveWorktree     string `json:"activeWorktree,omitempty"`
	MainWorktreeBranch string `json:"mainWorktreeBranch,omitempty"`
}

// Infrastructure service types.
const (
	InfraServiceTypeDocker     = "docker"
	InfraServiceTypeScript     = "script"
	InfraServiceTypeKubernetes = "kubernetes"
	ScriptRunnerShell          = "shell"
	ScriptRunnerPowerShell     = "powershell"
	InfraStatusStopped         = "stopped"
	InfraStatusRunning         = "running"
	InfraStatusFailed          = "failed"
)

// InfraService represents an infrastructure service.
type InfraService struct {
	DisplayName       string            `json:"displayName"`
	Ident             string            `json:"ident"`
	Type              string            `json:"type,omitempty"`
	ContainerBaseName string            `json:"containerBaseName,omitempty"`
	ShellPath         string            `json:"shellPath,omitempty"`
	PowerShellPath    string            `json:"powerShellPath,omitempty"`
	DefaultRunner     string            `json:"defaultRunner,omitempty"`
	Cwd               string            `json:"cwd,omitempty"`
	Args              []string          `json:"args,omitempty"`
	Env               map[string]string `json:"env,omitempty"`
	Status            string            `json:"status,omitempty"`
	LogPath           string            `json:"logPath,omitempty"`
	ExecutionHandle   *ExecutionHandle  `json:"executionHandle,omitempty"`
	Kubernetes        *KubernetesInfra  `json:"kubernetes,omitempty"`
}

// KubernetesInfra describes a Helm-backed Kubernetes infrastructure service.
type KubernetesInfra struct {
	Profile   string   `json:"profile,omitempty"`
	Provider  string   `json:"provider,omitempty"`
	Cluster   string   `json:"cluster,omitempty"`
	Context   string   `json:"context,omitempty"`
	ChartPath string   `json:"chartPath,omitempty"`
	Release   string   `json:"release,omitempty"`
	Namespace string   `json:"namespace,omitempty"`
	Values    []string `json:"values,omitempty"`
	Wait      bool     `json:"wait,omitempty"`
	Timeout   string   `json:"timeout,omitempty"`
}

// ExecutionHandle tracks active script infrastructure execution.
type ExecutionHandle struct {
	Mode      string `json:"mode"`
	PaneID    string `json:"paneId,omitempty"`
	PID       int    `json:"pid,omitempty"`
	Runner    string `json:"runner,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
	ExitCode  int    `json:"exitCode,omitempty"`
}

// appConfigFile is the on-disk representation of a single application
// definition.  It contains ONLY static configuration — runtime fields
// (branch, active_worktree, main_worktree_branch) are kept in the SQLite
// state database and must never be written here.
type appConfigFile struct {
	Ident             string `json:"ident"`
	DisplayName       string `json:"displayName"`
	RepositoryPath    string `json:"repositoryPath"`
	ContainerBaseName string `json:"containerBaseName,omitempty"`
	SourceType        string `json:"sourceType,omitempty"`
	Provider          string `json:"provider,omitempty"`
	GitMode           string `json:"gitMode,omitempty"`
}

// Manager manages application configuration and persistence.
type Manager interface {
	// GetApps returns all configured applications.
	GetApps() []App
	// GetInfraServices returns all configured infrastructure services.
	GetInfraServices() []InfraService
	// GetAppByIdent returns an app by its identifier.
	GetAppByIdent(ident string) (App, bool)
	// GetInfraServiceByIdent returns an infrastructure service by its identifier.
	GetInfraServiceByIdent(ident string) (InfraService, bool)
	// GetDisplayName returns the display name for an app or service given its ident.
	GetDisplayName(ident string) string
	// LoadConfig loads application configuration from disk and merges in
	// runtime state from the SQLite database.
	LoadConfig() error
	// AddApp adds a new application to the configuration.
	AddApp(newApp App) error
	// RemoveApp removes an application from the configuration.
	RemoveApp(ident string, deleteDir bool) error
	// SaveConfig writes the current configuration to disk.
	SaveConfig() error
	// UpdateAppActiveWorktree switches the active worktree for an app,
	// updates its LocalDirectoryPath in memory, and persists the runtime
	// state to the SQLite database (NOT the config JSON file).
	UpdateAppActiveWorktree(ident, branch string) error
	// SetMainWorktreeBranch records the branch that was actually checked out
	// in the primary worktree after the first clone, updating both the
	// in-memory state and the SQLite database.
	SetMainWorktreeBranch(ident, branch string) error
}

// appManager implements the Manager interface
type appManager struct {
	mu            sync.Mutex
	homeDir       string
	configDir     string
	stateStore    state.Store // nil is allowed; runtime state is skipped when absent
	apps          []App
	infraServices []InfraService
}

// NewManager creates a new application manager.
// stateStore may be nil; when provided, runtime state (branch, activeWorktree)
// is read from and written to the SQLite database rather than the config files.
func NewManager(homeDir string, configDir string, stateStore state.Store) Manager {
	return &appManager{
		homeDir:       homeDir,
		configDir:     configDir,
		stateStore:    stateStore,
		infraServices: []InfraService{},
	}
}

func (am *appManager) GetApps() []App {
	return am.apps
}

func (am *appManager) GetInfraServices() []InfraService {
	return am.infraServices
}

func (am *appManager) GetAppByIdent(ident string) (App, bool) {
	for _, app := range am.apps {
		if app.Ident == ident {
			return app, true
		}
	}
	return App{}, false
}

func (am *appManager) GetInfraServiceByIdent(ident string) (InfraService, bool) {
	for _, service := range am.infraServices {
		if service.Ident == ident {
			return service, true
		}
	}
	return InfraService{}, false
}

func (am *appManager) GetDisplayName(ident string) string {
	// Check regular apps first
	if app, found := am.GetAppByIdent(ident); found {
		return app.DisplayName
	}

	// Check infrastructure services
	if service, found := am.GetInfraServiceByIdent(ident); found {
		return service.DisplayName
	}

	// Fallback to ident
	return ident
}

func (am *appManager) LoadConfig() error {
	apps, err := am.loadAppsFromStorage()
	if err != nil {
		return err
	}
	am.apps = apps

	infraServices, err := am.loadInfraServicesFromStorage()
	if err != nil {
		return err
	}
	if len(infraServices) > 0 {
		am.infraServices = infraServices
	}

	// Overlay runtime state from the SQLite database (activeWorktree must be
	// known before we resolve LocalDirectoryPath).
	am.loadRuntimeState()

	for i := range am.apps {
		am.apps[i].LocalDirectoryPath = am.resolveActiveWorktreePath(am.apps[i])
	}

	am.updateBranches()

	return nil
}

// loadRuntimeState merges persisted runtime state (branch, activeWorktree,
// mainWorktreeBranch) from the SQLite database into the in-memory app list.
// If no state store is configured the call is a no-op.
//
// Legacy apps whose SQLite row has main_worktree_branch = "" (empty) but
// already have an active_worktree set are backfilled at startup: we read
// the primary worktree's current branch from git and persist it, so that
// resolveActiveWorktreePath can correctly distinguish the primary from a
// linked worktree.
func (am *appManager) loadRuntimeState() {
	if am.stateStore == nil {
		return
	}
	for i := range am.apps {
		ident := am.apps[i].Ident
		st, err := am.stateStore.GetAppState(ident)
		if err != nil {
			log.Printf("[WARN] state: failed to load state for %q: %v", ident, err)
			continue
		}
		if st.ActiveWorktree != "" {
			am.apps[i].ActiveWorktree = st.ActiveWorktree
		}
		if st.MainWorktreeBranch != "" {
			am.apps[i].MainWorktreeBranch = st.MainWorktreeBranch
		}
		// Branch will be refreshed from git in updateBranches(); only use the
		// stored value as a fallback when the repo is not yet cloned.
		if st.Branch != "" && am.apps[i].Branch == "" {
			am.apps[i].Branch = st.Branch
		}

		// Backfill for legacy apps: if an active worktree is set but
		// MainWorktreeBranch was never persisted, resolve it now from git so
		// that resolveActiveWorktreePath works correctly going forward.
		if am.apps[i].ActiveWorktree != "" && am.apps[i].MainWorktreeBranch == "" {
			if branch := am.primaryWorktreeBranch(ident); branch != "" {
				am.apps[i].MainWorktreeBranch = branch
				if err := am.stateStore.SetMainWorktreeBranch(ident, branch); err != nil {
					log.Printf("[WARN] state: failed to backfill MainWorktreeBranch for %q: %v", ident, err)
				} else {
					log.Printf("[INFO] state: backfilled MainWorktreeBranch=%q for %q", branch, ident)
				}
			}
		}
	}
}

func (am *appManager) AddApp(newApp App) error {
	am.mu.Lock()
	defer am.mu.Unlock()

	if newApp.Ident == "" {
		return fmt.Errorf("app ident is required")
	}
	if newApp.RepositoryPath == "" {
		return fmt.Errorf("app repository path is required")
	}
	if newApp.DisplayName == "" {
		return fmt.Errorf("app display name is required")
	}

	for _, existing := range am.apps {
		if existing.Ident == newApp.Ident {
			return fmt.Errorf("app with ident %q already exists", newApp.Ident)
		}
	}

	for _, existing := range am.apps {
		if existing.RepositoryPath == newApp.RepositoryPath {
			return fmt.Errorf("app with repository URL %q already exists (ident: %s)", newApp.RepositoryPath, existing.Ident)
		}
	}

	if err := am.saveAppFile(newApp); err != nil {
		return err
	}

	if am.stateStore != nil && newApp.Branch != "" {
		st := state.AppState{Ident: newApp.Ident, Branch: newApp.Branch}
		if newApp.ActiveWorktree != "" || newApp.MainWorktreeBranch != "" || newApp.GitMode == GitModeWorktree {
			st.ActiveWorktree = newApp.Branch
			st.MainWorktreeBranch = newApp.Branch
		}
		if err := am.stateStore.SetAppState(st); err != nil {
			return err
		}
	}

	am.apps = append(am.apps, newApp)
	for i := range am.apps {
		if !filepath.IsAbs(am.apps[i].LocalDirectoryPath) {
			am.apps[i].LocalDirectoryPath = am.resolveActiveWorktreePath(am.apps[i])
		}
	}

	return nil
}

func (am *appManager) RemoveApp(ident string, deleteDir bool) error {
	am.mu.Lock()
	defer am.mu.Unlock()

	if ident == "" {
		return fmt.Errorf("app ident is required")
	}

	found := false
	var removedApp App
	filtered := make([]App, 0, len(am.apps))
	for _, a := range am.apps {
		if a.Ident == ident {
			found = true
			removedApp = a
			continue
		}
		filtered = append(filtered, a)
	}

	if !found {
		return fmt.Errorf("app with ident %q not found", ident)
	}

	if err := os.Remove(am.appFilePath(removedApp)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("failed to remove app file for %q: %w", ident, err)
	}

	if deleteDir {
		// Both worktree-mode and branch-mode apps now live under
		// $DEVENV_HOME/{ident}/ (primary at {ident}/{ident}/, linked worktrees
		// at {ident}/{ident}.{branch}/), so we always delete the container dir.
		dirPath := filepath.Join(am.homeDir, removedApp.Ident)
		if dirPath != "" && dirPath != am.homeDir {
			_ = os.RemoveAll(dirPath)
		}
	}

	am.apps = filtered
	for i := range am.apps {
		if !filepath.IsAbs(am.apps[i].LocalDirectoryPath) {
			am.apps[i].LocalDirectoryPath = am.resolveActiveWorktreePath(am.apps[i])
		}
	}

	return nil
}

func (am *appManager) SaveConfig() error {
	am.mu.Lock()
	defer am.mu.Unlock()

	if err := os.MkdirAll(am.appsDirPath(), 0755); err != nil {
		return fmt.Errorf("failed to create apps directory: %w", err)
	}
	if err := os.MkdirAll(am.librariesDirPath(), 0755); err != nil {
		return fmt.Errorf("failed to create libraries directory: %w", err)
	}

	appEntries, err := os.ReadDir(am.appsDirPath())
	if err != nil {
		return fmt.Errorf("failed to read apps directory: %w", err)
	}
	libraryEntries, err := os.ReadDir(am.librariesDirPath())
	if err != nil {
		return fmt.Errorf("failed to read libraries directory: %w", err)
	}

	allowedApps := make(map[string]struct{}, len(am.apps))
	allowedLibraries := make(map[string]struct{}, len(am.apps))
	for _, a := range am.apps {
		if err := am.saveAppFile(a); err != nil {
			return err
		}
		fileName := a.Ident + ".json"
		if a.AppType == TypeLIB {
			allowedLibraries[fileName] = struct{}{}
		} else {
			allowedApps[fileName] = struct{}{}
		}
	}

	for _, entry := range appEntries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		if _, keep := allowedApps[entry.Name()]; keep {
			continue
		}
		if err := os.Remove(filepath.Join(am.appsDirPath(), entry.Name())); err != nil {
			return fmt.Errorf("failed to remove stale app file %s: %w", entry.Name(), err)
		}
	}

	for _, entry := range libraryEntries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		if _, keep := allowedLibraries[entry.Name()]; keep {
			continue
		}
		if err := os.Remove(filepath.Join(am.librariesDirPath(), entry.Name())); err != nil {
			return fmt.Errorf("failed to remove stale library file %s: %w", entry.Name(), err)
		}
	}

	if err := am.saveInfraServicesFile(am.infraServices); err != nil {
		return err
	}

	return nil
}

// updateBranches updates the current branch for each app from their git
// repositories and persists the discovered branch to the SQLite state database.
// When the repo directory no longer exists on disk (e.g. manually deleted),
// Branch is cleared to "" so the app is treated as not yet cloned.
func (am *appManager) updateBranches() {
	for i := range am.apps {
		if am.apps[i].LocalDirectoryPath == "" {
			continue
		}

		// Get current branch from git.
		branch := am.getCurrentBranchFromGit(am.apps[i].LocalDirectoryPath)
		if branch != "" {
			am.apps[i].Branch = branch
			if am.stateStore != nil {
				if err := am.stateStore.SetBranch(am.apps[i].Ident, branch); err != nil {
					log.Printf("[WARN] state: failed to persist branch for %q: %v", am.apps[i].Ident, err)
				}
			}
			continue
		}

		// getCurrentBranchFromGit returned "": this happens both when the repo
		// is not yet cloned and when the directory has been deleted externally.
		// If the directory does not exist, clear the stale cached branch so the
		// app is shown as "not cloned" rather than displaying an outdated branch.
		if _, err := os.Stat(am.apps[i].LocalDirectoryPath); os.IsNotExist(err) {
			if am.stateStore == nil {
				am.apps[i].Branch = ""
				continue
			}
			st, err := am.stateStore.GetAppState(am.apps[i].Ident)
			if err != nil || st.Branch == "" {
				am.apps[i].Branch = ""
			}
		}
	}
}

// getCurrentBranchFromGit reads the current branch from a git repository.
// It handles both primary worktrees (.git is a directory) and linked worktrees
// (.git is a file containing a "gitdir: <path>" pointer).
func (am *appManager) getCurrentBranchFromGit(repoPath string) string {
	gitPath := filepath.Join(repoPath, ".git")
	info, err := os.Stat(gitPath)
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		return ""
	}

	var headFile string
	if info.IsDir() {
		// Primary worktree or plain clone — HEAD is directly inside .git/.
		headFile = filepath.Join(gitPath, "HEAD")
	} else {
		// Linked worktree — .git is a file with "gitdir: <actual-git-dir>".
		// Follow the pointer to find the per-worktree HEAD.
		raw, err := os.ReadFile(gitPath)
		if err != nil {
			return ""
		}
		gitdirLine := strings.TrimSpace(string(raw))
		if !strings.HasPrefix(gitdirLine, "gitdir: ") {
			return ""
		}
		actualGitDir := strings.TrimPrefix(gitdirLine, "gitdir: ")
		if !filepath.IsAbs(actualGitDir) {
			actualGitDir = filepath.Join(repoPath, actualGitDir)
		}
		headFile = filepath.Join(actualGitDir, "HEAD")
	}

	content, err := os.ReadFile(headFile)
	if err != nil {
		return ""
	}
	headStr := strings.TrimSpace(string(content))
	if strings.HasPrefix(headStr, "ref: refs/heads/") {
		return strings.TrimPrefix(headStr, "ref: refs/heads/")
	}
	return ""
}

// worktreeBranchToDir converts a branch name to a filesystem-safe directory
// segment, mirroring worktrunk's {{ branch | sanitize }} filter.
func worktreeBranchToDir(branch string) string {
	return strings.NewReplacer("/", "-", "\\", "-").Replace(branch)
}

// primaryWorktreeBranch returns the branch currently checked out in the
// primary worktree of an app (always at $homeDir/{ident}/{ident}/.git/HEAD),
// regardless of which worktree is currently active.  Returns "" on any error
// (repo not yet cloned, detached HEAD, etc.).
func (am *appManager) primaryWorktreeBranch(ident string) string {
	primaryDir := filepath.Join(am.homeDir, ident, ident)
	return am.getCurrentBranchFromGit(primaryDir)
}

// resolveActiveWorktreePath returns the absolute path of the currently active
// worktree for the app, with a disk-existence fallback chain:
//
//  1. If the active worktree is the primary worktree (or unset), return the
//     primary path.
//  2. If a linked worktree was recorded as active, return that path — but only
//     if the directory actually exists on disk.  If it has been removed outside
//     of devenv (e.g. manual `rm -rf`), fall through to the primary worktree.
//  3. If the primary worktree directory also no longer exists, return it anyway
//     so the rest of the system can treat the repo as "not cloned yet".
//
// Layout:
//
//	$DEVENV_HOME/{ident}/{ident}/                — primary worktree
//	$DEVENV_HOME/{ident}/{ident}.{safe-branch}/  — linked worktree
func (am *appManager) resolveActiveWorktreePath(a App) string {
	appRoot := filepath.Join(am.homeDir, a.Ident)
	primary := filepath.Join(appRoot, a.Ident)
	active := a.ActiveWorktree

	// Return the primary worktree when:
	//   • no active worktree recorded (app not yet cloned / never switched), or
	//   • the active branch equals the main worktree branch (explicit primary selection).
	// Note: we intentionally do NOT short-circuit when MainWorktreeBranch is empty
	// — that was a legacy guard that prevented linked worktrees from being used
	// on apps whose SQLite row pre-dates the main_worktree_branch column.
	if active == "" || (a.MainWorktreeBranch != "" && active == a.MainWorktreeBranch) {
		return primary
	}

	// A specific linked worktree was recorded as active.  Only return its path
	// if the directory still exists on disk; otherwise fall back to primary.
	linked := filepath.Join(appRoot, a.Ident+"."+worktreeBranchToDir(active))
	if _, err := os.Stat(linked); err == nil {
		return linked
	}
	log.Printf("[INFO] devenv: active worktree directory %q no longer exists, falling back to primary worktree for app %q", linked, a.Ident)
	return primary
}

// UpdateAppActiveWorktree changes which worktree is active for an app,
// updates LocalDirectoryPath in memory, and persists the runtime state to the
// SQLite database. The config JSON file is NOT modified.
func (am *appManager) UpdateAppActiveWorktree(ident, branch string) error {
	am.mu.Lock()
	defer am.mu.Unlock()

	for i := range am.apps {
		if am.apps[i].Ident != ident {
			continue
		}
		am.apps[i].ActiveWorktree = branch
		am.apps[i].Branch = branch
		am.apps[i].LocalDirectoryPath = am.resolveActiveWorktreePath(am.apps[i])

		if am.stateStore != nil {
			if err := am.stateStore.SetAppState(state.AppState{
				Ident:              ident,
				Branch:             branch,
				ActiveWorktree:     branch,
				MainWorktreeBranch: am.apps[i].MainWorktreeBranch, // preserve existing value
			}); err != nil {
				return fmt.Errorf("failed to persist active worktree state for %s: %w", ident, err)
			}
		}
		return nil
	}
	return fmt.Errorf("app %q not found", ident)
}

// SetMainWorktreeBranch records the branch that was actually checked out in
// the primary worktree after the first clone.  It updates both the in-memory
// app state and the SQLite database.  The config JSON file is NOT modified.
func (am *appManager) SetMainWorktreeBranch(ident, branch string) error {
	am.mu.Lock()
	defer am.mu.Unlock()

	for i := range am.apps {
		if am.apps[i].Ident != ident {
			continue
		}
		am.apps[i].MainWorktreeBranch = branch

		if am.stateStore != nil {
			if err := am.stateStore.SetMainWorktreeBranch(ident, branch); err != nil {
				return fmt.Errorf("failed to persist main worktree branch for %s: %w", ident, err)
			}
		}
		return nil
	}
	return fmt.Errorf("app %q not found", ident)
}

func (am *appManager) appsDirPath() string {
	// apps definitions now live under apps/definitions
	return filepath.Join(am.configDir, "apps", "definitions")
}

func (am *appManager) librariesDirPath() string {
	// libraries definitions now live under libraries/definitions
	return filepath.Join(am.configDir, "libraries", "definitions")
}

func (am *appManager) infraServicesDirPath() string {
	// infrastructure definitions now live under infrastructure/definitions
	return filepath.Join(am.configDir, "infrastructure", "definitions")
}

func (am *appManager) appFilePath(app App) string {
	dir := am.appsDirPath()
	if app.AppType == TypeLIB {
		dir = am.librariesDirPath()
	}
	return filepath.Join(dir, app.Ident+".json")
}

func (am *appManager) loadAppsFromStorage() ([]App, error) {
	return am.loadAppsFromSplitDirectories()
}

func (am *appManager) loadAppsFromSplitDirectories() ([]App, error) {
	apps, err := am.loadAppsFromDirectory(am.appsDirPath(), TypeAPP)
	if err != nil {
		return nil, err
	}

	libraries, err := am.loadAppsFromDirectory(am.librariesDirPath(), TypeLIB)
	if err != nil {
		return nil, err
	}

	return append(apps, libraries...), nil
}

func (am *appManager) loadAppsFromDirectory(dirPath string, defaultType string) ([]App, error) {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read app directory %s: %w", dirPath, err)
	}

	apps := make([]App, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		filePath := filepath.Join(dirPath, entry.Name())
		data, err := os.ReadFile(filePath)
		if err != nil {
			return nil, fmt.Errorf("failed to read app file %s: %w", entry.Name(), err)
		}

		var cfg appConfigFile
		if err := json.Unmarshal(data, &cfg); err != nil {
			return nil, fmt.Errorf("failed to parse app file %s: %w", entry.Name(), err)
		}

		app := App{
			Ident:          cfg.Ident,
			DisplayName:    cfg.DisplayName,
			RepositoryPath: cfg.RepositoryPath,
			// LocalDirectoryPath is a runtime field; always derived from Ident at load time.
			// Branch, ActiveWorktree, and MainWorktreeBranch are NOT loaded
			// from the config file; they are runtime state loaded separately
			// from the SQLite database.
			AppType:           defaultType,
			ContainerBaseName: cfg.ContainerBaseName,
			SourceType:        cfg.SourceType,
			Provider:          cfg.Provider,
			GitMode:           cfg.GitMode,
		}
		if app.Ident == "" {
			app.Ident = strings.TrimSuffix(entry.Name(), ".json")
		}
		apps = append(apps, app)
	}

	return apps, nil
}

func (am *appManager) loadInfraServicesFromStorage() ([]InfraService, error) {
	return am.loadInfraServicesFromDirectory()
}

func (am *appManager) loadInfraServicesFromDirectory() ([]InfraService, error) {
	entries, err := os.ReadDir(am.infraServicesDirPath())
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read infra-services directory %s: %w", am.infraServicesDirPath(), err)
	}

	infraServices := make([]InfraService, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		filePath := filepath.Join(am.infraServicesDirPath(), entry.Name())
		data, err := os.ReadFile(filePath)
		if err != nil {
			return nil, fmt.Errorf("failed to read infra service file %s: %w", entry.Name(), err)
		}

		var svc InfraService
		if err := json.Unmarshal(data, &svc); err != nil {
			return nil, fmt.Errorf("failed to parse infra service file %s: %w", entry.Name(), err)
		}
		if svc.Ident == "" {
			svc.Ident = strings.TrimSuffix(entry.Name(), ".json")
		}
		expandInfraConfigPaths(&svc, am.configDir)
		if err := normalizeInfraService(&svc); err != nil {
			return nil, fmt.Errorf("invalid infra service file %s: %w", entry.Name(), err)
		}
		infraServices = append(infraServices, svc)
	}

	return infraServices, nil
}

func expandInfraConfigPaths(svc *InfraService, configDir string) {
	expand := func(value string) string {
		value = strings.ReplaceAll(value, "${CONFIG}", configDir)
		return strings.ReplaceAll(value, "$CONFIG", configDir)
	}
	svc.ShellPath = expand(svc.ShellPath)
	svc.PowerShellPath = expand(svc.PowerShellPath)
	svc.Cwd = expand(svc.Cwd)
	svc.LogPath = expand(svc.LogPath)
	if svc.Kubernetes == nil {
		return
	}
	svc.Kubernetes.ChartPath = expand(svc.Kubernetes.ChartPath)
	for i := range svc.Kubernetes.Values {
		svc.Kubernetes.Values[i] = expand(svc.Kubernetes.Values[i])
	}
}

func normalizeInfraService(svc *InfraService) error {
	if strings.TrimSpace(svc.Ident) == "" {
		return fmt.Errorf("infra service ident is required")
	}
	if strings.TrimSpace(svc.Type) == "" {
		svc.Type = InfraServiceTypeDocker
	}
	switch svc.Type {
	case InfraServiceTypeDocker:
		return nil
	case InfraServiceTypeScript:
		if strings.TrimSpace(svc.ShellPath) == "" && strings.TrimSpace(svc.PowerShellPath) == "" {
			return fmt.Errorf("script service %q requires shellPath or powerShellPath", svc.Ident)
		}
		if svc.DefaultRunner != "" && svc.DefaultRunner != ScriptRunnerShell && svc.DefaultRunner != ScriptRunnerPowerShell {
			return fmt.Errorf("script service %q defaultRunner must be %q or %q", svc.Ident, ScriptRunnerShell, ScriptRunnerPowerShell)
		}
		if svc.DefaultRunner == ScriptRunnerShell && strings.TrimSpace(svc.ShellPath) == "" {
			return fmt.Errorf("script service %q defaultRunner shell requires shellPath", svc.Ident)
		}
		if svc.DefaultRunner == ScriptRunnerPowerShell && strings.TrimSpace(svc.PowerShellPath) == "" {
			return fmt.Errorf("script service %q defaultRunner powershell requires powerShellPath", svc.Ident)
		}
		if svc.Status == "" {
			svc.Status = InfraStatusStopped
		}
		return nil
	case InfraServiceTypeKubernetes:
		if svc.Kubernetes == nil {
			return fmt.Errorf("kubernetes service %q requires kubernetes config", svc.Ident)
		}
		if strings.TrimSpace(svc.Kubernetes.ChartPath) == "" {
			return fmt.Errorf("kubernetes service %q requires chartPath", svc.Ident)
		}
		if svc.Kubernetes.Profile == "" {
			svc.Kubernetes.Profile = "local"
		}
		if svc.Kubernetes.Release == "" {
			svc.Kubernetes.Release = svc.Ident
		}
		if svc.Kubernetes.Namespace == "" {
			svc.Kubernetes.Namespace = "default"
		}
		if svc.Status == "" {
			svc.Status = InfraStatusStopped
		}
		return nil
	default:
		return fmt.Errorf("unsupported infra service type %q", svc.Type)
	}
}

func (am *appManager) saveAppFile(app App) error {
	if app.Ident == "" {
		return fmt.Errorf("app ident is required")
	}
	dirPath := am.appsDirPath()
	if app.AppType == TypeLIB {
		dirPath = am.librariesDirPath()
	}
	if err := os.MkdirAll(dirPath, 0755); err != nil {
		return fmt.Errorf("failed to create app directory: %w", err)
	}

	cfg := appConfigFile{
		Ident:          app.Ident,
		DisplayName:    app.DisplayName,
		RepositoryPath: app.RepositoryPath,
		// Branch, ActiveWorktree, and MainWorktreeBranch are runtime state —
		// never written to the config file.
		// LocalDirectoryPath is always derived from Ident at load time — not stored.
		ContainerBaseName: app.ContainerBaseName,
		SourceType:        app.SourceType,
		Provider:          app.Provider,
		GitMode:           app.GitMode,
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal app %s: %w", app.Ident, err)
	}

	if err := os.WriteFile(am.appFilePath(app), data, 0644); err != nil {
		return fmt.Errorf("failed to write app file for %s: %w", app.Ident, err)
	}

	return nil
}

func (am *appManager) saveInfraServicesFile(infra []InfraService) error {
	if err := os.MkdirAll(am.infraServicesDirPath(), 0755); err != nil {
		return fmt.Errorf("failed to create infra-services directory: %w", err)
	}

	existingEntries, err := os.ReadDir(am.infraServicesDirPath())
	if err != nil {
		return fmt.Errorf("failed to read infra-services directory: %w", err)
	}

	allowed := make(map[string]struct{}, len(infra))
	for _, svc := range infra {
		if err := normalizeInfraService(&svc); err != nil {
			return err
		}

		data, err := json.MarshalIndent(svc, "", "  ")
		if err != nil {
			return fmt.Errorf("failed to marshal infra service %s: %w", svc.Ident, err)
		}

		fileName := svc.Ident + ".json"
		if err := os.WriteFile(filepath.Join(am.infraServicesDirPath(), fileName), data, 0644); err != nil {
			return fmt.Errorf("failed to write infra service file %s: %w", fileName, err)
		}
		allowed[fileName] = struct{}{}
	}

	for _, entry := range existingEntries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		if _, keep := allowed[entry.Name()]; keep {
			continue
		}
		if err := os.Remove(filepath.Join(am.infraServicesDirPath(), entry.Name())); err != nil {
			return fmt.Errorf("failed to remove stale infra service file %s: %w", entry.Name(), err)
		}
	}

	return nil
}

// Convenience methods to implement interfaces from other packages

// GetIdent returns the app identifier
func (a App) GetIdent() string {
	return a.Ident
}

// GetContainerBaseName returns the container base name, falling back to Ident.
func (a App) GetContainerBaseName() string {
	if a.ContainerBaseName != "" {
		return a.ContainerBaseName
	}
	return a.Ident
}

// GetRepositoryPath returns the repository path
func (a App) GetRepositoryPath() string {
	return a.RepositoryPath
}

// GetLocalDirectoryPath returns the local directory path
func (a App) GetLocalDirectoryPath() string {
	return a.LocalDirectoryPath
}

// GetBranch returns the branch name
func (a App) GetBranch() string {
	return a.Branch
}

// GetMainWorktreeBranch returns the branch checked out in the primary worktree.
func (a App) GetMainWorktreeBranch() string { return a.MainWorktreeBranch }

func (a App) GetProviderName() string {
	if a.Provider != "" {
		return a.Provider
	}
	return a.SourceType
}

// GetIdent returns the infrastructure service identifier
func (i InfraService) GetIdent() string {
	return i.Ident
}

// GetContainerBaseName returns the container base name, falling back to Ident.
func (i InfraService) GetContainerBaseName() string {
	if i.ContainerBaseName != "" {
		return i.ContainerBaseName
	}
	return i.Ident
}
