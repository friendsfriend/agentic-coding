package git

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	gitHttp "github.com/go-git/go-git/v5/plumbing/transport/http"
)

// Repository provides Git operations for managing repositories.
type Repository interface {
	// GetBranches returns all branches from a remote repository.
	GetBranches(repoURL string) ([]string, error)
	// GetLocalBranches returns all local branches for an app.
	GetLocalBranches(app App) ([]string, error)
	// UpdateOrCreateRepo updates an existing repository or creates a new one.
	// For worktree-mode apps it returns the actual branch that was checked out
	// as the primary worktree (which may differ from the requested branch when
	// the remote redirected to its default branch). For non-worktree apps the
	// returned string is always empty.
	UpdateOrCreateRepo(app App) (string, error)
	// GetCurrentBranch returns the current branch name.
	GetCurrentBranch(app App) string
	// GetStatus returns the Git status as a string.
	GetStatus(app App) string
	// Push pushes changes to the remote repository.
	Push(app App) error
	// Fetch fetches changes from the remote repository.
	Fetch(app App) error
	// Pull pulls changes from the remote repository.
	Pull(app App) error
	// Checkout switches to a different branch.
	Checkout(app App, branch string) error
	// RefreshCache forces a cache refresh for a specific path.
	RefreshCache(path string) error
	// ListWorktrees returns all worktrees for a worktree-mode app.
	ListWorktrees(app App) ([]WorktreeInfo, error)
	// AddWorktree creates a linked worktree for branch and returns its path.
	AddWorktree(app App, branch string) (string, error)
	// RemoveWorktree removes a linked worktree. The primary worktree cannot be removed.
	RemoveWorktree(app App, branch string) error
}

// App represents an application with a Git repository.
type App interface {
	// GetIdent returns the app identifier.
	GetIdent() string
	// GetRepositoryPath returns the repository path.
	GetRepositoryPath() string
	// GetLocalDirectoryPath returns the local directory path.
	GetLocalDirectoryPath() string
	// GetBranch returns the branch name.
	GetBranch() string
	// GetMainWorktreeBranch returns the branch of the primary worktree.
	GetMainWorktreeBranch() string
}

// WorktreeInfo describes a single git worktree.
type WorktreeInfo struct {
	Branch string `json:"branch"`
	Path   string `json:"path"`
	IsMain bool   `json:"isMain"` // true = primary worktree (has .git dir)
	Active bool   `json:"active"` // true = currently selected by devenv
}

// AuthProvider provides Git authentication credentials.
type AuthProvider interface {
	// GetUsername returns the Git username.
	GetUsername() string
	// GetToken returns the Git token.
	GetToken() string
}

// MultiAuthProvider extends AuthProvider with per-URL credential resolution.
// If the auth provider implements this interface, gitRepository will use
// CredentialsFor(repoURL) instead of GetUsername()/GetToken() so that
// GitHub and GitLab credentials can be routed independently.
type MultiAuthProvider interface {
	AuthProvider
	CredentialsFor(repoURL string) (username, token string)
}

// gitRepository implements the Repository interface
type gitRepository struct {
	auth     AuthProvider
	cache    *repoCache
	recorder ActionRecorder
	recordMu sync.RWMutex
}

// repoCache for performance optimization
type repoCache struct {
	repos      map[string]*git.Repository
	lastUpdate map[string]time.Time
	ttl        time.Duration
	mutex      sync.RWMutex
	opMutexes  map[string]*sync.Mutex // Per-repository operation locks
}

// wtWorktreePathTemplate is the worktrunk path template that produces devenv's
// layout when the primary worktree lives at $DEVENV_HOME/{ident}/{ident}/:
//
//	primary: $DEVENV_HOME/{ident}/{ident}/
//	linked:  $DEVENV_HOME/{ident}/{ident}.{sanitized-branch}/
//
// This is worktrunk's built-in default, set explicitly so that any user-level
// worktree-path config is overridden for devenv-managed repos.
const wtWorktreePathTemplate = `{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}`

// runGitCommand runs a git command in dir, returning stdout, stderr, and any error.
func (gr *gitRepository) SetActionRecorder(recorder ActionRecorder) {
	gr.recordMu.Lock()
	gr.recorder = recorder
	gr.recordMu.Unlock()
}

func (gr *gitRepository) hasActionRecorder() bool {
	gr.recordMu.RLock()
	defer gr.recordMu.RUnlock()
	return gr.recorder != nil
}

func (gr *gitRepository) record(step ActionStep) {
	gr.recordMu.RLock()
	recorder := gr.recorder
	gr.recordMu.RUnlock()
	if recorder != nil {
		recorder(step)
	}
}

func gitExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return 1
}

func (gr *gitRepository) runGitCommand(dir string, args ...string) (string, string, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	label := strings.Join(args, " ")
	gr.record(ActionStep{Label: label, Command: "git -C " + dir + " " + strings.Join(args, " "), Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: gitExitCode(err), Err: err})
	return stdout.String(), stderr.String(), err
}

// runWtCommand runs a worktrunk (wt) command in dir with the devenv path
// template set via environment variable.
func (gr *gitRepository) runWtCommand(dir string, args ...string) (string, string, error) {
	wtBin, err := exec.LookPath("wt")
	if err != nil {
		return "", "", fmt.Errorf("worktrunk (wt) not found in PATH: install from https://worktrunk.dev")
	}
	cmd := exec.Command(wtBin, append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "WORKTRUNK_WORKTREE_PATH="+wtWorktreePathTemplate)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	gr.record(ActionStep{Label: strings.Join(args, " "), Command: wtBin + " -C " + dir + " " + strings.Join(args, " "), Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: gitExitCode(err), Err: err})
	return stdout.String(), stderr.String(), err
}

// appRootDir returns $DEVENV_HOME/{ident}/ — the directory that contains both
// the primary worktree and all linked worktrees for a worktree-mode app.
func appRootDir(app App) string {
	// LocalDirectoryPath is always the active worktree; the app root is one level up.
	return filepath.Dir(app.GetLocalDirectoryPath())
}

// primaryWorktreeDir returns the path of the primary worktree:
//
//	$DEVENV_HOME/{ident}/{ident}/
func primaryWorktreeDir(app App) string {
	return filepath.Join(appRootDir(app), app.GetIdent())
}

// linkedWorktreeDir returns the expected path of a linked worktree for branch:
//
//	$DEVENV_HOME/{ident}/{ident}.{sanitized-branch}/
func linkedWorktreeDir(app App, branch string) string {
	safe := strings.NewReplacer("/", "-", "\\", "-").Replace(branch)
	return filepath.Join(appRootDir(app), app.GetIdent()+"."+safe)
}

// currentBranchAtPath reads the active branch name directly from the .git/HEAD
// file in a primary worktree directory. Returns "" if the path is not a git repo
// or HEAD is in detached state.
func currentBranchAtPath(dir string) string {
	content, err := os.ReadFile(filepath.Join(dir, ".git", "HEAD"))
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(content))
	return strings.TrimPrefix(s, "ref: refs/heads/")
}

// NewRepository creates a new Git repository manager
func NewRepository(auth AuthProvider) Repository {
	return &gitRepository{
		auth: auth,
		cache: &repoCache{
			repos:      make(map[string]*git.Repository),
			lastUpdate: make(map[string]time.Time),
			ttl:        30 * time.Second,
			opMutexes:  make(map[string]*sync.Mutex),
		},
	}
}

// credentialsFor resolves username and token for the given repo URL.
// Uses MultiAuthProvider routing when available, otherwise falls back to the flat AuthProvider.
func (gr *gitRepository) credentialsFor(repoURL string) (username, token string) {
	if gr.auth == nil {
		return "", ""
	}
	if multi, ok := gr.auth.(MultiAuthProvider); ok {
		return multi.CredentialsFor(repoURL)
	}
	return gr.auth.GetUsername(), gr.auth.GetToken()
}

// getRepository returns cached repository if valid, otherwise opens from disk
func (gr *gitRepository) getRepository(path string) (*git.Repository, error) {
	gr.cache.mutex.RLock()

	// Check if cached repo is still valid
	if repo, exists := gr.cache.repos[path]; exists {
		if lastUpdate, timeExists := gr.cache.lastUpdate[path]; timeExists {
			if time.Since(lastUpdate) < gr.cache.ttl {
				gr.cache.mutex.RUnlock()
				return repo, nil
			}
		}
	}

	gr.cache.mutex.RUnlock()

	// Cache is invalid or doesn't exist, need to open repository
	return gr.refreshRepositoryCache(path)
}

// refreshRepositoryCache opens repository from disk and updates cache
func (gr *gitRepository) refreshRepositoryCache(path string) (*git.Repository, error) {
	repo, err := git.PlainOpen(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open repository at %s: %w", path, err)
	}

	gr.cache.mutex.Lock()
	gr.cache.repos[path] = repo
	gr.cache.lastUpdate[path] = time.Now()
	gr.cache.mutex.Unlock()

	return repo, nil
}

func (gr *gitRepository) RefreshCache(path string) error {
	_, err := gr.refreshRepositoryCache(path)
	return err
}

// invalidateRepositoryCache removes cached repository for given path
func (gr *gitRepository) invalidateRepositoryCache(path string) {
	gr.cache.mutex.Lock()
	delete(gr.cache.repos, path)
	delete(gr.cache.lastUpdate, path)
	gr.cache.mutex.Unlock()
}

// lockRepo locks operations for a specific repository path
func (gr *gitRepository) lockRepo(path string) {
	gr.cache.mutex.Lock()
	if gr.cache.opMutexes[path] == nil {
		gr.cache.opMutexes[path] = &sync.Mutex{}
	}
	mu := gr.cache.opMutexes[path]
	gr.cache.mutex.Unlock()
	mu.Lock()
}

// unlockRepo unlocks operations for a specific repository path
func (gr *gitRepository) unlockRepo(path string) {
	gr.cache.mutex.RLock()
	if mu, exists := gr.cache.opMutexes[path]; exists {
		mu.Unlock()
	}
	gr.cache.mutex.RUnlock()
}

func (gr *gitRepository) GetBranches(repoURL string) ([]string, error) {
	remote := git.NewRemote(nil, &config.RemoteConfig{Name: "temp", URLs: []string{repoURL}})

	refPrefix := "refs/heads/"
	listOptions := &git.ListOptions{}

	username, token := gr.credentialsFor(repoURL)
	if username != "" && token != "" {
		listOptions.Auth = &gitHttp.BasicAuth{
			Username: username,
			Password: token,
		}
	}

	refList, err := remote.List(listOptions)
	if err != nil {
		return nil, fmt.Errorf("failed to list remote branches: %w", err)
	}

	var branches []string
	for _, ref := range refList {
		refName := ref.Name().String()
		if !strings.HasPrefix(refName, refPrefix) {
			continue
		}
		branchName := refName[len(refPrefix):]
		branches = append(branches, branchName)
	}
	return branches, nil
}

func (gr *gitRepository) UpdateOrCreateRepo(app App) (string, error) {
	exists, err := gr.existsDir(app.GetLocalDirectoryPath())
	if err != nil {
		return "", fmt.Errorf("failed to check if directory exists: %w", err)
	}

	if !exists {
		if err := gr.checkout(app); err != nil {
			return "", fmt.Errorf("failed to clone repository: %w", err)
		}
	}

	isGitDir, err := gr.existsDir(fmt.Sprintf("%s/.git", app.GetLocalDirectoryPath()))
	if err != nil {
		return "", fmt.Errorf("failed to check git directory: %w", err)
	}

	if !isGitDir {
		return "", fmt.Errorf("directory exists but is not a git repository")
	}

	return "", gr.switchAndPullBranch(app)
}

// checkout clones a repository into app.GetLocalDirectoryPath().
// For non-worktree apps this is $DEVENV_HOME/{ident}/{ident}/, so we must
// ensure the parent directory ($DEVENV_HOME/{ident}/) exists before cloning.
func (gr *gitRepository) checkout(app App) error {
	targetDir := app.GetLocalDirectoryPath()
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return fmt.Errorf("failed to create repository directory: %w", err)
	}

	cloneOptions := &git.CloneOptions{
		URL:               app.GetRepositoryPath(),
		ReferenceName:     plumbing.NewBranchReferenceName(app.GetBranch()),
		SingleBranch:      false,
		RecurseSubmodules: git.DefaultSubmoduleRecursionDepth,
	}

	username, token := gr.credentialsFor(app.GetRepositoryPath())
	if username != "" && token != "" {
		cloneOptions.Auth = &gitHttp.BasicAuth{
			Username: username,
			Password: token,
		}
	}

	_, err := git.PlainClone(targetDir, false, cloneOptions)
	if err != nil {
		return fmt.Errorf("clone operation failed: %w", err)
	}
	return nil
}

// switchAndPullBranch switches to target branch and pulls latest changes
func (gr *gitRepository) switchAndPullBranch(app App) error {
	repo, err := gr.getRepository(app.GetLocalDirectoryPath())
	if err != nil {
		return fmt.Errorf("failed to open repository: %w", err)
	}

	worktree, err := repo.Worktree()
	if err != nil {
		return fmt.Errorf("failed to get worktree: %w", err)
	}

	status, err := worktree.Status()
	if err != nil {
		return fmt.Errorf("failed to get status: %w", err)
	}
	if !status.IsClean() {
		return fmt.Errorf("repository has local changes")
	}

	branchExists, err := gr.doesBranchExist(app, app.GetBranch())
	if err != nil {
		return fmt.Errorf("failed to check if branch exists: %w", err)
	}

	// Snapshot gitignored files before any worktree modification so that
	// go-git cannot accidentally delete them (go-git's HardReset does not
	// always respect .gitignore, unlike native git).
	backupDir, backupErr := gr.backupIgnoredFiles(app.GetLocalDirectoryPath())
	if backupErr != nil {
		log.Printf("[WARN] devenv: could not back up ignored files for %s: %v", app.GetIdent(), backupErr)
	}
	defer gr.restoreIgnoredFiles(app.GetLocalDirectoryPath(), backupDir)

	if !branchExists {
		if err := gr.createBranchFromRemote(app, app.GetBranch()); err != nil {
			return fmt.Errorf("failed to create branch: %w", err)
		}
	}

	fetchOptions := &git.FetchOptions{
		RemoteName: "origin",
		RefSpecs:   []config.RefSpec{"+refs/heads/*:refs/remotes/origin/*"},
		Force:      true,
	}

	username, token := gr.credentialsFor(app.GetRepositoryPath())
	if username != "" && token != "" {
		fetchOptions.Auth = &gitHttp.BasicAuth{
			Username: username,
			Password: token,
		}
	}

	if err := repo.Fetch(fetchOptions); err != nil && err != git.NoErrAlreadyUpToDate {
		return fmt.Errorf("fetch operation failed: %w", err)
	}

	refName := plumbing.NewRemoteReferenceName("origin", app.GetBranch())
	ref, err := repo.Reference(refName, true)
	if err != nil {
		return fmt.Errorf("failed to get remote reference: %w", err)
	}

	if err := worktree.Reset(&git.ResetOptions{
		Commit: ref.Hash(),
		Mode:   git.HardReset,
	}); err != nil {
		return fmt.Errorf("reset operation failed: %w", err)
	}

	if err := worktree.Checkout(&git.CheckoutOptions{
		Branch: plumbing.NewBranchReferenceName(app.GetBranch()),
	}); err != nil {
		return fmt.Errorf("checkout operation failed: %w", err)
	}

	// Invalidate cache after checkout operations
	gr.invalidateRepositoryCache(app.GetLocalDirectoryPath())

	return nil
}

// doesBranchExist checks if a branch exists locally
func (gr *gitRepository) doesBranchExist(app App, branch string) (bool, error) {
	repo, err := gr.getRepository(app.GetLocalDirectoryPath())
	if err != nil {
		return false, fmt.Errorf("failed to open repository: %w", err)
	}

	branches, err := repo.Branches()
	if err != nil {
		return false, fmt.Errorf("failed to get branches: %w", err)
	}

	exists := false
	branches.ForEach(func(ref *plumbing.Reference) error {
		if ref.Name().Short() == branch {
			exists = true
		}
		return nil
	})
	return exists, nil
}

// createBranchFromRemote creates a new branch from remote
func (gr *gitRepository) createBranchFromRemote(app App, branch string) error {
	repo, err := gr.getRepository(app.GetLocalDirectoryPath())
	if err != nil {
		return fmt.Errorf("failed to open repository: %w", err)
	}

	// Get the remote reference for the branch
	remoteRefName := plumbing.NewRemoteReferenceName("origin", branch)
	remoteRef, err := repo.Reference(remoteRefName, true)
	if err != nil {
		return fmt.Errorf("failed to get remote reference for branch %s: %w", branch, err)
	}

	worktree, err := repo.Worktree()
	if err != nil {
		return fmt.Errorf("failed to get worktree: %w", err)
	}

	// Create local branch tracking the remote branch.
	// Force is not set: callers assert a clean working tree before reaching here.
	if err := worktree.Checkout(&git.CheckoutOptions{
		Branch: plumbing.NewBranchReferenceName(branch),
		Hash:   remoteRef.Hash(),
		Create: true,
	}); err != nil {
		return fmt.Errorf("failed to create branch: %w", err)
	}

	// Invalidate cache after branch creation
	gr.invalidateRepositoryCache(app.GetLocalDirectoryPath())

	return nil
}

func (gr *gitRepository) GetCurrentBranch(app App) string {
	if app.GetLocalDirectoryPath() == "" {
		return ""
	}

	repoPath := app.GetLocalDirectoryPath()
	gitPath := filepath.Join(repoPath, ".git")

	info, err := os.Stat(gitPath)
	if err != nil {
		return ""
	}

	// Read HEAD directly for both cases rather than using go-git, which has
	// incomplete support for repos with linked worktrees and may fail even for
	// the primary worktree when worktrees are configured.
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

	headContent, err := os.ReadFile(headFile)
	if err != nil {
		return ""
	}
	headStr := strings.TrimSpace(string(headContent))
	if strings.HasPrefix(headStr, "ref: refs/heads/") {
		return strings.TrimPrefix(headStr, "ref: refs/heads/")
	}
	return ""
}

func (gr *gitRepository) GetStatus(app App) string {
	if app.GetLocalDirectoryPath() == "" {
		return "x"
	}

	exists, err := gr.existsDir(fmt.Sprintf("%s/.git", app.GetLocalDirectoryPath()))
	if err != nil || !exists {
		return "x"
	}

	// Lock this repository for the duration of the operation
	path := app.GetLocalDirectoryPath()
	gr.lockRepo(path)
	defer gr.unlockRepo(path)

	repo, err := gr.getRepository(path)
	if err != nil {
		return "error"
	}

	worktree, err := repo.Worktree()
	if err != nil {
		return "error"
	}

	wtStatus, err := worktree.Status()
	if err != nil {
		return "error"
	}

	added, changed, removed := 0, 0, 0
	for _, fileStatus := range wtStatus {
		isAdded := fileStatus.Staging == git.Added || fileStatus.Worktree == git.Untracked
		isRemoved := fileStatus.Staging == git.Deleted || fileStatus.Worktree == git.Deleted
		isChanged := fileStatus.Staging == git.Modified || fileStatus.Staging == git.Renamed || fileStatus.Staging == git.Copied ||
			fileStatus.Worktree == git.Modified || fileStatus.Worktree == git.Renamed || fileStatus.Worktree == git.Copied

		switch {
		case isRemoved:
			removed++
		case isAdded:
			added++
		case isChanged:
			changed++
		}
	}

	parts := []string{}
	if added > 0 {
		parts = append(parts, fmt.Sprintf("+%d", added))
	}
	if changed > 0 {
		parts = append(parts, fmt.Sprintf("~%d", changed))
	}
	if removed > 0 {
		parts = append(parts, fmt.Sprintf("-%d", removed))
	}
	if len(parts) > 0 {
		return strings.Join(parts, " ")
	}
	return "✓"
}

func (gr *gitRepository) Push(app App) error {
	// Instrumented requests use native Git so action history contains real command results.
	if gr.hasActionRecorder() {
		path := app.GetLocalDirectoryPath()
		gr.lockRepo(path)
		defer gr.unlockRepo(path)
		_, _, err := gr.runGitCommand(path, "push", "origin")
		return err
	}
	// Lock this repository for the duration of the operation
	path := app.GetLocalDirectoryPath()
	gr.lockRepo(path)
	defer gr.unlockRepo(path)

	repo, err := gr.getRepository(path)
	if err != nil {
		return fmt.Errorf("failed to open repository: %w", err)
	}

	pushOptions := &git.PushOptions{
		RemoteName: "origin",
	}

	username, token := gr.credentialsFor(app.GetRepositoryPath())
	if username != "" && token != "" {
		pushOptions.Auth = &gitHttp.BasicAuth{
			Username: username,
			Password: token,
		}
	}

	err = repo.Push(pushOptions)
	if err != nil && err != git.NoErrAlreadyUpToDate {
		return fmt.Errorf("push operation failed: %w", err)
	}

	// Invalidate cache after push operation
	gr.invalidateRepositoryCache(path)

	return nil
}

func (gr *gitRepository) Fetch(app App) error {
	if gr.hasActionRecorder() {
		path := app.GetLocalDirectoryPath()
		gr.lockRepo(path)
		defer gr.unlockRepo(path)
		_, _, err := gr.runGitCommand(path, "fetch", "--force", "origin", "+refs/heads/*:refs/remotes/origin/*")
		return err
	}
	// Lock this repository for the duration of the operation
	path := app.GetLocalDirectoryPath()
	gr.lockRepo(path)
	defer gr.unlockRepo(path)

	repo, err := gr.getRepository(path)
	if err != nil {
		return fmt.Errorf("failed to open repository: %w", err)
	}

	// Prepare fetch options with force refspec
	fetchOptions := &git.FetchOptions{
		RemoteName: "origin",
		RefSpecs:   []config.RefSpec{"+refs/heads/*:refs/remotes/origin/*"},
		Force:      true,
	}

	username, token := gr.credentialsFor(app.GetRepositoryPath())
	if username != "" && token != "" {
		fetchOptions.Auth = &gitHttp.BasicAuth{
			Username: username,
			Password: token,
		}
	}

	if err := repo.Fetch(fetchOptions); err != nil && err != git.NoErrAlreadyUpToDate {
		return fmt.Errorf("fetch operation failed: %w", err)
	}

	return nil
}

func (gr *gitRepository) Pull(app App) error {
	if gr.hasActionRecorder() {
		path := app.GetLocalDirectoryPath()
		gr.lockRepo(path)
		defer gr.unlockRepo(path)
		branchOut, _, err := gr.runGitCommand(path, "rev-parse", "--abbrev-ref", "HEAD")
		if err != nil {
			return err
		}
		branch := strings.TrimSpace(branchOut)
		if _, _, err = gr.runGitCommand(path, "fetch", "--force", "origin", "+refs/heads/*:refs/remotes/origin/*"); err != nil {
			return err
		}
		_, _, err = gr.runGitCommand(path, "reset", "--hard", "origin/"+branch)
		return err
	}
	// Lock this repository for the duration of the operation
	path := app.GetLocalDirectoryPath()
	gr.lockRepo(path)
	defer gr.unlockRepo(path)

	repo, err := gr.getRepository(path)
	if err != nil {
		return fmt.Errorf("failed to open repository: %w", err)
	}

	worktree, err := repo.Worktree()
	if err != nil {
		return fmt.Errorf("failed to get worktree: %w", err)
	}

	// Get current branch
	head, err := repo.Head()
	if err != nil {
		return fmt.Errorf("failed to get HEAD: %w", err)
	}

	// Get branch name
	branchName := head.Name().Short()

	// Prepare fetch options with force refspec
	fetchOptions := &git.FetchOptions{
		RemoteName: "origin",
		RefSpecs:   []config.RefSpec{"+refs/heads/*:refs/remotes/origin/*"},
		Force:      true,
	}

	username, token := gr.credentialsFor(app.GetRepositoryPath())
	if username != "" && token != "" {
		fetchOptions.Auth = &gitHttp.BasicAuth{
			Username: username,
			Password: token,
		}
	}

	// Fetch the latest changes
	if err := repo.Fetch(fetchOptions); err != nil && err != git.NoErrAlreadyUpToDate {
		return fmt.Errorf("fetch operation failed: %w", err)
	}

	// Get the remote reference for current branch
	remoteRefName := plumbing.NewRemoteReferenceName("origin", branchName)
	remoteRef, err := repo.Reference(remoteRefName, true)
	if err != nil {
		return fmt.Errorf("failed to get remote reference: %w", err)
	}

	// Snapshot gitignored files before the reset so go-git cannot accidentally
	// delete them (go-git's HardReset does not always respect .gitignore).
	backupDir, backupErr := gr.backupIgnoredFiles(path)
	if backupErr != nil {
		log.Printf("[WARN] devenv: could not back up ignored files for %s: %v", app.GetIdent(), backupErr)
	}
	defer gr.restoreIgnoredFiles(path, backupDir)

	// Reset to remote branch (hard reset to match remote exactly)
	if err := worktree.Reset(&git.ResetOptions{
		Commit: remoteRef.Hash(),
		Mode:   git.HardReset,
	}); err != nil {
		return fmt.Errorf("reset operation failed: %w", err)
	}

	// Invalidate cache after pull operation
	gr.invalidateRepositoryCache(path)

	return nil
}

func (gr *gitRepository) GetLocalBranches(app App) ([]string, error) {
	repo, err := gr.getRepository(app.GetLocalDirectoryPath())
	if err != nil {
		return nil, fmt.Errorf("failed to open repository: %w", err)
	}

	branches, err := repo.Branches()
	if err != nil {
		return nil, fmt.Errorf("failed to get branches: %w", err)
	}

	var branchNames []string
	branches.ForEach(func(ref *plumbing.Reference) error {
		branchNames = append(branchNames, ref.Name().Short())
		return nil
	})

	return branchNames, nil
}

func (gr *gitRepository) Checkout(app App, branch string) error {
	if gr.hasActionRecorder() {
		path := app.GetLocalDirectoryPath()
		gr.lockRepo(path)
		defer gr.unlockRepo(path)
		if _, err := os.Stat(filepath.Join(path, ".git")); os.IsNotExist(err) {
			_, _, cloneErr := gr.runGitCommand(".", "clone", "--branch", branch, app.GetRepositoryPath(), path)
			return cloneErr
		}
		if _, _, err := gr.runGitCommand(path, "status", "--porcelain"); err != nil {
			return err
		}
		branchList, _, err := gr.runGitCommand(path, "branch", "--list", branch)
		if err != nil {
			return err
		}
		if strings.TrimSpace(branchList) == "" {
			remoteList, _, remoteErr := gr.runGitCommand(path, "branch", "--remote", "--list", "origin/"+branch)
			if remoteErr != nil {
				return remoteErr
			}
			if strings.TrimSpace(remoteList) != "" {
				_, _, createErr := gr.runGitCommand(path, "switch", "-c", branch, "--track", "origin/"+branch)
				return createErr
			}
			_, _, createErr := gr.runGitCommand(path, "switch", "-c", branch)
			return createErr
		}
		_, _, err = gr.runGitCommand(path, "switch", branch)
		return err
	}
	// Lock this repository for the duration of the operation
	path := app.GetLocalDirectoryPath()
	gr.lockRepo(path)
	defer gr.unlockRepo(path)

	// If the local repository doesn't exist yet, clone it directly onto the
	// requested branch so we don't need any further checkout step.
	repoExists, err := gr.existsDir(fmt.Sprintf("%s/.git", path))
	if err != nil {
		return fmt.Errorf("failed to check repository directory: %w", err)
	}
	if !repoExists {
		cloneOptions := &git.CloneOptions{
			URL:           app.GetRepositoryPath(),
			ReferenceName: plumbing.NewBranchReferenceName(branch),
			SingleBranch:  false,
		}
		cloneUsername, cloneToken := gr.credentialsFor(app.GetRepositoryPath())
		if cloneUsername != "" && cloneToken != "" {
			cloneOptions.Auth = &gitHttp.BasicAuth{
				Username: cloneUsername,
				Password: cloneToken,
			}
		}
		if _, cloneErr := git.PlainClone(path, false, cloneOptions); cloneErr != nil {
			return fmt.Errorf("failed to clone repository: %w", cloneErr)
		}
		gr.invalidateRepositoryCache(path)
		return nil
	}

	repo, err := gr.getRepository(path)
	if err != nil {
		return fmt.Errorf("failed to open repository: %w", err)
	}

	worktree, err := repo.Worktree()
	if err != nil {
		return fmt.Errorf("failed to get worktree: %w", err)
	}

	// Check for uncommitted changes
	status, err := worktree.Status()
	if err != nil {
		return fmt.Errorf("failed to get status: %w", err)
	}
	if !status.IsClean() {
		return fmt.Errorf("repository has uncommitted changes")
	}

	// Snapshot gitignored files before any worktree modification so that
	// go-git cannot accidentally delete them during checkout.
	backupDir, backupErr := gr.backupIgnoredFiles(path)
	if backupErr != nil {
		log.Printf("[WARN] devenv: could not back up ignored files for %s: %v", app.GetIdent(), backupErr)
	}
	defer gr.restoreIgnoredFiles(path, backupDir)

	// Check if branch exists locally
	branchExists, err := gr.doesBranchExist(app, branch)
	if err != nil {
		return fmt.Errorf("failed to check if branch exists: %w", err)
	}

	if !branchExists {
		// Branch doesn't exist locally, try to create from remote first
		err := gr.createBranchFromRemote(app, branch)
		if err != nil {
			// If the remote reference doesn't exist, create a new local branch from HEAD
			if errors.Is(err, plumbing.ErrReferenceNotFound) {
				headRef, headErr := repo.Head()
				if headErr != nil {
					return fmt.Errorf("failed to get HEAD: %w", headErr)
				}
				if createErr := worktree.Checkout(&git.CheckoutOptions{
					Branch: plumbing.NewBranchReferenceName(branch),
					Hash:   headRef.Hash(),
					Create: true,
				}); createErr != nil {
					return fmt.Errorf("failed to create new branch: %w", createErr)
				}
				gr.invalidateRepositoryCache(app.GetLocalDirectoryPath())
			} else {
				return fmt.Errorf("failed to create branch from remote: %w", err)
			}
		}
	} else {
		// Branch exists locally, just checkout
		if err := worktree.Checkout(&git.CheckoutOptions{
			Branch: plumbing.NewBranchReferenceName(branch),
		}); err != nil {
			return fmt.Errorf("checkout operation failed: %w", err)
		}
	}

	// Invalidate cache after checkout
	gr.invalidateRepositoryCache(app.GetLocalDirectoryPath())

	return nil
}

// cloneIntoPrimaryWorktree clones the remote repository into targetDir on branch.
// It returns the actual branch that was checked out (which may differ from the
// requested branch when the remote does not have it and the default is used).
func (gr *gitRepository) cloneIntoPrimaryWorktree(app App, targetDir, branch string) (string, error) {
	if gr.hasActionRecorder() {
		if err := os.MkdirAll(filepath.Dir(targetDir), 0755); err != nil {
			return "", fmt.Errorf("failed to create primary worktree directory: %w", err)
		}
		if _, _, err := gr.runGitCommand(".", "clone", "--branch", branch, app.GetRepositoryPath(), targetDir); err != nil {
			if _, _, fallbackErr := gr.runGitCommand(".", "clone", app.GetRepositoryPath(), targetDir); fallbackErr != nil {
				return "", fallbackErr
			}
		}
		return gr.resolveHeadBranch(targetDir), nil
	}
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create primary worktree directory: %w", err)
	}
	cloneOptions := &git.CloneOptions{
		URL:               app.GetRepositoryPath(),
		ReferenceName:     plumbing.NewBranchReferenceName(branch),
		SingleBranch:      false,
		RecurseSubmodules: git.DefaultSubmoduleRecursionDepth,
	}
	username, token := gr.credentialsFor(app.GetRepositoryPath())
	if username != "" && token != "" {
		cloneOptions.Auth = &gitHttp.BasicAuth{Username: username, Password: token}
	}
	if _, err := git.PlainClone(targetDir, false, cloneOptions); err != nil {
		// The configured branch (e.g. mainWorktreeBranch = "main") does not exist
		// on the remote. Fall back to cloning the remote's default branch so the
		// primary worktree can still be created.
		if strings.Contains(err.Error(), "reference not found") {
			log.Printf("[WARN] devenv: branch %q not found on remote for %s, cloning remote default branch",
				branch, app.GetIdent())
			cloneOptions.ReferenceName = ""
			if _, retryErr := git.PlainClone(targetDir, false, cloneOptions); retryErr != nil {
				return "", fmt.Errorf("clone into primary worktree failed (fallback to default branch): %w", retryErr)
			}
			// Determine the actual branch that was checked out.
			actualBranch := gr.resolveHeadBranch(targetDir)
			return actualBranch, nil
		}
		return "", fmt.Errorf("clone into primary worktree failed: %w", err)
	}
	// Requested branch was available; return it as the actual branch.
	return branch, nil
}

// resolveHeadBranch opens the repository at dir and returns the short branch
// name that HEAD currently points to. If it cannot be determined an empty
// string is returned rather than an error, so callers can treat it as
// best-effort information.
func (gr *gitRepository) resolveHeadBranch(dir string) string {
	repo, err := gr.getRepository(dir)
	if err != nil {
		return ""
	}
	head, err := repo.Head()
	if err != nil {
		return ""
	}
	return head.Name().Short()
}

// ListWorktrees returns all worktrees for a worktree-mode app.
func (gr *gitRepository) ListWorktrees(app App) ([]WorktreeInfo, error) {
	primaryDir := primaryWorktreeDir(app)
	// Return an empty list if the primary worktree hasn't been cloned yet.
	// Checking for .git (not just the directory) avoids a git exit-128 fatal
	// "not a git repository" error when the directory exists but is empty.
	if _, err := os.Stat(filepath.Join(primaryDir, ".git")); os.IsNotExist(err) {
		return nil, nil
	}
	stdout, _, err := gr.runGitCommand(primaryDir, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, fmt.Errorf("git worktree list failed: %w", err)
	}
	activePath := app.GetLocalDirectoryPath()
	var results []WorktreeInfo
	var cur WorktreeInfo
	isFirst := true
	flush := func() {
		if cur.Path == "" {
			return
		}
		cur.IsMain = isFirst
		cur.Active = cur.Path == activePath
		results = append(results, cur)
		cur = WorktreeInfo{}
		isFirst = false
	}
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			flush()
			continue
		}
		switch {
		case strings.HasPrefix(line, "worktree "):
			cur.Path = strings.TrimPrefix(line, "worktree ")
		case strings.HasPrefix(line, "branch "):
			cur.Branch = strings.TrimPrefix(line, "branch refs/heads/")
		}
	}
	flush()
	return results, nil
}

// AddWorktree creates a linked worktree for branch using worktrunk, then
// returns its absolute path. If the worktree already exists it is returned
// immediately without running wt.
func (gr *gitRepository) AddWorktree(app App, branch string) (string, error) {
	primaryDir := primaryWorktreeDir(app)
	targetDir := linkedWorktreeDir(app, branch)

	gr.lockRepo(primaryDir)
	defer gr.unlockRepo(primaryDir)

	// Return immediately if the linked worktree already exists.
	if info, err := os.Stat(targetDir); err == nil && info.IsDir() {
		return targetDir, nil
	}

	// Ensure the primary worktree exists before asking worktrunk to add a
	// linked one — wt runs git commands inside it and will fail with
	// "No such file or directory" if it has not been cloned yet.
	if _, err := os.Stat(filepath.Join(primaryDir, ".git")); os.IsNotExist(err) {
		mainBranch := app.GetMainWorktreeBranch()
		if mainBranch == "" {
			mainBranch = app.GetBranch()
		}
		if mkErr := os.MkdirAll(appRootDir(app), 0755); mkErr != nil {
			return "", fmt.Errorf("failed to create app root directory: %w", mkErr)
		}
		if _, cloneErr := gr.cloneIntoPrimaryWorktree(app, primaryDir, mainBranch); cloneErr != nil {
			return "", fmt.Errorf("primary worktree not found and clone failed: %w", cloneErr)
		}
	}

	// If the requested branch is already checked out in the primary worktree
	// (either because it was just cloned, or because the configured
	// mainWorktreeBranch didn't exist and the clone fell back to the remote's
	// default branch), return primaryDir directly — no linked worktree needed.
	if primaryBranch := currentBranchAtPath(primaryDir); primaryBranch == branch {
		log.Printf("[INFO] devenv: branch %q is the primary worktree for %s, skipping linked worktree creation",
			branch, app.GetIdent())
		return primaryDir, nil
	}

	// Use `wt switch` without `--create` so that worktrunk creates a local
	// tracking branch when the branch already exists on the remote (which is
	// always the case for branches selectable in the UI). This ensures that
	// `branch.<name>.remote` and `branch.<name>.merge` are written into
	// .git/config, which is required for `git pull` to work — both from
	// IntelliJ and from native git inside the linked worktree.
	_, stderr, err := gr.runWtCommand(primaryDir, "switch", branch, "--no-cd", "--yes")
	if err != nil {
		// wt refuses to switch when the target path is already occupied by a
		// worktree that is on a different branch (e.g. after the folder was
		// deleted and re-cloned onto a different branch, leaving the primary
		// worktree dir itself as the "occupied" path for the main branch).
		// wt's own error message explicitly says to run `git switch <branch>`
		// inside that directory, so we do exactly that as a fallback.
		if strings.Contains(stderr, "there's a worktree at the expected path") ||
			strings.Contains(stderr, "Path occupied") {
			occupiedDir := targetDir
			// The error refers to primaryDir when wt maps the branch to the
			// primary worktree location (i.e. when branch == mainWorktreeBranch
			// but the directory currently holds a different branch after a
			// fresh clone).
			if _, statErr := os.Stat(filepath.Join(targetDir, ".git")); os.IsNotExist(statErr) {
				occupiedDir = primaryDir
			}
			log.Printf("[WARN] devenv: wt switch %q reported occupied path at %s; falling back to git switch", branch, occupiedDir)
			if _, _, gitErr := gr.runGitCommand(occupiedDir, "switch", branch); gitErr != nil {
				return "", fmt.Errorf("wt switch %q failed and git switch fallback also failed: %w\nwt stderr: %s", branch, gitErr, stderr)
			}
			gr.invalidateRepositoryCache(occupiedDir)
			return occupiedDir, nil
		}
		return "", fmt.Errorf("wt switch %q failed: %w\nstderr: %s", branch, err, stderr)
	}
	gr.invalidateRepositoryCache(targetDir)
	return targetDir, nil
}

// RemoveWorktree removes a linked worktree using worktrunk.
// Falls back to plain git if wt is unavailable. The primary worktree cannot be removed.
func (gr *gitRepository) RemoveWorktree(app App, branch string) error {
	if branch == app.GetMainWorktreeBranch() {
		return fmt.Errorf("cannot remove the primary worktree (branch %q)", branch)
	}
	primaryDir := primaryWorktreeDir(app)
	targetDir := linkedWorktreeDir(app, branch)

	gr.lockRepo(primaryDir)
	defer gr.unlockRepo(primaryDir)

	if _, _, err := gr.runWtCommand(primaryDir, "remove", branch, "--yes"); err != nil {
		log.Printf("[WARN] devenv: wt remove %q failed (%v); falling back to git worktree remove", branch, err)
		if _, _, gitErr := gr.runGitCommand(primaryDir, "worktree", "remove", "--force", targetDir); gitErr != nil {
			return fmt.Errorf("wt remove failed; git worktree remove also failed: %w", gitErr)
		}
		gr.runGitCommand(primaryDir, "worktree", "prune")
	}
	gr.invalidateRepositoryCache(targetDir)
	return nil
}

// backupIgnoredFiles snapshots all gitignored files present in repoPath into a
// temporary directory, preserving their relative sub-paths. The returned path
// must be passed to restoreIgnoredFiles when the git operation is complete;
// restoreIgnoredFiles removes the directory. Returns ("", nil) when there is
// nothing to back up or when the git binary is unavailable.
func (gr *gitRepository) backupIgnoredFiles(repoPath string) (string, error) {
	cmd := exec.Command("git", "-C", repoPath, "ls-files",
		"--others", "--ignored", "--exclude-standard", "-z")
	out, err := cmd.Output()
	if err != nil || len(out) == 0 {
		return "", nil
	}

	backupDir, err := os.MkdirTemp("", "devenv-ignored-backup-*")
	if err != nil {
		return "", fmt.Errorf("failed to create backup directory: %w", err)
	}

	for _, rel := range strings.Split(string(out), "\x00") {
		if rel == "" {
			continue
		}
		src := filepath.Join(repoPath, rel)
		dst := filepath.Join(backupDir, rel)
		if mkErr := os.MkdirAll(filepath.Dir(dst), 0755); mkErr != nil {
			continue
		}
		if cpErr := copyFile(src, dst); cpErr != nil {
			log.Printf("[WARN] devenv: could not back up ignored file %q: %v", rel, cpErr)
		}
	}

	return backupDir, nil
}

// restoreIgnoredFiles copies any files from backupDir that are missing under
// repoPath back to their original locations, then removes backupDir entirely.
// A blank backupDir is silently ignored.
func (gr *gitRepository) restoreIgnoredFiles(repoPath, backupDir string) {
	if backupDir == "" {
		return
	}
	defer os.RemoveAll(backupDir)

	walkErr := filepath.WalkDir(backupDir, func(backupPath string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(backupDir, backupPath)
		if relErr != nil {
			return nil
		}
		dst := filepath.Join(repoPath, rel)
		if _, statErr := os.Stat(dst); os.IsNotExist(statErr) {
			if mkErr := os.MkdirAll(filepath.Dir(dst), 0755); mkErr != nil {
				return nil
			}
			if cpErr := copyFile(backupPath, dst); cpErr != nil {
				log.Printf("[WARN] devenv: could not restore ignored file %q: %v", rel, cpErr)
			}
		}
		return nil
	})
	if walkErr != nil {
		log.Printf("[WARN] devenv: error walking ignored-files backup %q: %v", backupDir, walkErr)
	}
}

// copyFile copies src to dst, preserving the source file's permission bits.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	info, err := in.Stat()
	if err != nil {
		return err
	}

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}

// existsDir checks if a directory exists
func (gr *gitRepository) existsDir(dir string) (bool, error) {
	info, err := os.Stat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return info.IsDir(), nil
}
