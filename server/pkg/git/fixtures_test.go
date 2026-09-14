package git

// Cross-runtime Git fixtures (`port-git-providers-and-ai-to-bun`, task 1.2).
//
// Each fixture is a runtime-neutral recipe plus the outputs the Go
// implementation actually produced for it. The Bun Git service replays the
// same recipe in its own temporary home and asserts the recorded outputs, so
// parity is proven by fixture rather than by replaying a mutation against both
// runtimes.
//
// Regenerate with:
//
//	DEVENV_INTEGRATION_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/integrations/git \
//	  go test ./pkg/git -run TestWriteGitFixtures
//
// Without the env var the generator is skipped, so a normal `go test ./...`
// never writes into the repository.
import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fixtureApp is the app identity both runtimes resolve paths from. Every path
// is a recipe key (`primary`, `linked:<branch>`, `remote`, `other`) so the
// fixture stays independent of the machine it was captured on.
type fixtureApp struct {
	Ident              string `json:"ident"`
	RepositoryPath     string `json:"repositoryPath"`
	LocalDirectoryPath string `json:"localDirectoryPath"`
	Branch             string `json:"branch"`
	MainWorktreeBranch string `json:"mainWorktreeBranch"`
	ActiveWorktree     string `json:"activeWorktree"`
}

// fixtureSetup is one replayable setup step: either a `git` invocation or a
// file write, always relative to a recipe key.
type fixtureSetup struct {
	Cwd   string            `json:"cwd"`
	Args  []string          `json:"args,omitempty"`
	Write map[string]string `json:"write,omitempty"`
}

// fixtureOperation is one recorded capability call. `error` records whether the
// call was expected to fail; `value`/`message` record what Go produced.
type fixtureOperation struct {
	Op      string `json:"op"`
	Branch  string `json:"branch,omitempty"`
	RepoURL string `json:"repoURL,omitempty"`
	Error   bool   `json:"error,omitempty"`
	Value   string `json:"value,omitempty"`
	Message string `json:"message,omitempty"`
	// LibraryMessage marks a diagnostic whose wording comes from go-git, the
	// library the Bun port replaces. The Bun side asserts that such a call fails
	// with a bounded one-line diagnostic rather than reproducing go-git's text.
	LibraryMessage bool `json:"libraryMessage,omitempty"`
}

type fixtureFile struct {
	Case       string             `json:"case"`
	Note       string             `json:"note"`
	App        fixtureApp         `json:"app"`
	Setup      []fixtureSetup     `json:"setup"`
	Operations []fixtureOperation `json:"operations"`
}

// fixtureGitApp implements App over recipe keys.
type fixtureGitApp struct {
	ident              string
	repositoryPath     string
	localDirectoryPath string
	branch             string
	mainWorktreeBranch string
}

func (a *fixtureGitApp) GetIdent() string              { return a.ident }
func (a *fixtureGitApp) GetRepositoryPath() string     { return a.repositoryPath }
func (a *fixtureGitApp) GetLocalDirectoryPath() string { return a.localDirectoryPath }
func (a *fixtureGitApp) GetBranch() string             { return a.branch }
func (a *fixtureGitApp) GetMainWorktreeBranch() string { return a.mainWorktreeBranch }

// recipeKey resolves a recipe key against the fixture root.
func recipeKey(root, key string) string {
	if strings.HasPrefix(key, "linked:") {
		branch := strings.TrimPrefix(key, "linked:")
		return filepath.Join(root, "demo", "demo."+strings.NewReplacer("/", "-", "\\", "-").Replace(branch))
	}
	switch key {
	case "root":
		return root
	case "remote":
		return filepath.Join(root, "remote.git")
	case "other":
		return filepath.Join(root, "other")
	default: // "primary" and anything else resolves to the primary worktree
		return filepath.Join(root, "demo", "demo")
	}
}

// expand replaces the recipe placeholders a step or URL may carry.
func expand(root, value string) string {
	for _, key := range []string{"root", "remote", "primary", "other"} {
		value = strings.ReplaceAll(value, "{{"+key+"}}", recipeKey(root, key))
	}
	return value
}

func TestWriteGitFixtures(t *testing.T) {
	dir := os.Getenv("DEVENV_INTEGRATION_FIXTURE_DIR")
	if dir == "" {
		t.Skip("DEVENV_INTEGRATION_FIXTURE_DIR not set")
	}
	for _, fixture := range gitFixtures() {
		// Resolve the temporary directory once: a fixture records paths and
		// diagnostics relative to this root, and macOS resolves /var through a
		// symlink that would otherwise leak a machine-specific prefix.
		root, err := filepath.EvalSymlinks(t.TempDir())
		if err != nil {
			t.Fatalf("resolve fixture root: %v", err)
		}
		materialize(t, root, fixture.Setup)
		// The recipe is written before the operations run so a failing
		// operation still leaves a replayable recipe on disk.
		writeJSON(t, filepath.Join(dir, fixture.Case, "recipe.json"), fixture)
		app := fixtureGitApp{
			ident:              fixture.App.Ident,
			repositoryPath:     expand(root, fixture.App.RepositoryPath),
			localDirectoryPath: recipeKey(root, fixture.App.LocalDirectoryPath),
			branch:             fixture.App.Branch,
			mainWorktreeBranch: fixture.App.MainWorktreeBranch,
		}
		repo := NewRepository(nil)
		recorded := fixture
		recorded.Operations = runOperations(t, root, repo, &app, fixture.Operations)
		for i := range recorded.Operations {
			recorded.Operations[i].Message = strings.ReplaceAll(recorded.Operations[i].Message, root, "{{root}}")
		}
		writeJSON(t, filepath.Join(dir, fixture.Case, "expected.json"), recorded)
	}
}

func materialize(t *testing.T, root string, setup []fixtureSetup) {
	t.Helper()
	for _, step := range setup {
		cwd := recipeKey(root, step.Cwd)
		if err := os.MkdirAll(cwd, 0755); err != nil {
			t.Fatalf("mkdir %s: %v", cwd, err)
		}
		for name, content := range step.Write {
			target := filepath.Join(cwd, name)
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				t.Fatalf("mkdir %s: %v", filepath.Dir(target), err)
			}
			if err := os.WriteFile(target, []byte(content), 0644); err != nil {
				t.Fatalf("write %s: %v", target, err)
			}
		}
		if len(step.Args) == 0 {
			continue
		}
		args := make([]string, 0, len(step.Args))
		for _, arg := range step.Args {
			args = append(args, expand(root, arg))
		}
		runGit(t, cwd, args...)
	}
}

func runGit(t *testing.T, cwd string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=fixture", "GIT_AUTHOR_EMAIL=fixture@example.com",
		"GIT_COMMITTER_NAME=fixture", "GIT_COMMITTER_EMAIL=fixture@example.com",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, cwd, err, out)
	}
	return string(out)
}

func runOperations(t *testing.T, root string, repo Repository, app *fixtureGitApp, operations []fixtureOperation) []fixtureOperation {
	t.Helper()
	recorded := make([]fixtureOperation, 0, len(operations))
	for _, op := range operations {
		result := op
		switch op.Op {
		case "currentBranch":
			result.Value = repo.GetCurrentBranch(app)
		case "status":
			result.Value = repo.GetStatus(app)
		case "localBranches":
			branches, err := repo.GetLocalBranches(app)
			recordErr(&result, err)
			result.Value = strings.Join(branches, ",")
		case "remoteBranches":
			branches, err := repo.GetBranches(expand(root, op.RepoURL))
			recordErr(&result, err)
			result.Value = strings.Join(branches, ",")
		case "listWorktrees":
			worktrees, err := repo.ListWorktrees(app)
			recordErr(&result, err)
			parts := make([]string, 0, len(worktrees))
			for _, wt := range worktrees {
				parts = append(parts, fmt.Sprintf("%s|%s|%t|%t",
					wt.Branch, normalizePath(root, wt.Path), wt.IsMain, wt.Active))
			}
			result.Value = strings.Join(parts, ";")
		case "addWorktree":
			path, err := repo.AddWorktree(app, op.Branch)
			recordErr(&result, err)
			result.Value = normalizePath(root, path)
		case "removeWorktree":
			recordErr(&result, repo.RemoveWorktree(app, op.Branch))
		case "checkout":
			recordErr(&result, repo.Checkout(app, op.Branch))
		case "fetch":
			recordErr(&result, repo.Fetch(app))
		case "pull":
			recordErr(&result, repo.Pull(app))
		case "push":
			recordErr(&result, repo.Push(app))
		case "headFile":
			head, err := os.ReadFile(filepath.Join(recipeKey(root, op.Branch), ".git", "HEAD"))
			recordErr(&result, err)
			result.Value = strings.TrimSpace(string(head))
		default:
			t.Fatalf("unknown fixture operation %q", op.Op)
		}
		recorded = append(recorded, result)
	}
	return recorded
}

// recordErr keeps the diagnostic text stable across runtimes: the fixture
// records only that the call failed plus the first line of the message, since
// the wrapped wording differs between go-git and native git.
func recordErr(result *fixtureOperation, err error) {
	if err == nil {
		result.Error = false
		result.Message = ""
		return
	}
	result.Error = true
	result.Message = strings.SplitN(err.Error(), "\n", 2)[0]
	result.LibraryMessage = isLibraryMessage(result.Message)
}

// isLibraryMessage reports whether a diagnostic is worded by go-git rather than
// by the ported Git package itself.
func isLibraryMessage(message string) bool {
	for _, marker := range []string{
		"failed to open repository",
		"repository does not exist",
		"reference not found",
		"already up-to-date",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

// normalizePath rewrites a machine-specific absolute path into its recipe form
// so a captured fixture is valid on any machine.
func normalizePath(root, path string) string {
	if path == "" {
		return ""
	}
	resolved := path
	if evaluated, err := filepath.EvalSymlinks(path); err == nil {
		resolved = evaluated
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || strings.HasPrefix(rel, "..") {
		return filepath.ToSlash(resolved)
	}
	return filepath.ToSlash(rel)
}

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	data, err := json.MarshalIndent(value, "", "\t")
	if err != nil {
		t.Fatalf("marshal %s: %v", path, err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// gitFixtures is the captured recipe set. Each recipe is runtime-neutral: only
// `git` argv, file writes and capability calls.
func gitFixtures() []fixtureFile {
	return []fixtureFile{
		{
			Case: "worktree-lifecycle",
			Note: "linked worktree creation, ownership protection and removal",
			App: fixtureApp{
				Ident: "demo", RepositoryPath: "{{remote}}",
				LocalDirectoryPath: "linked:feature", Branch: "feature",
				MainWorktreeBranch: "main", ActiveWorktree: "feature",
			},
			Setup: []fixtureSetup{
				{Cwd: "remote", Args: []string{"init", "-q", "--bare", "-b", "main"}},
				{Cwd: "primary", Args: []string{"init", "-q", "-b", "main"}},
				{Cwd: "primary", Write: map[string]string{"README.md": "hello\n"}},
				{Cwd: "primary", Args: []string{"add", "README.md"}},
				{Cwd: "primary", Args: []string{"commit", "-q", "-m", "init"}},
				{Cwd: "primary", Args: []string{"remote", "add", "origin", "{{remote}}"}},
				{Cwd: "primary", Args: []string{"push", "-q", "-u", "origin", "main"}},
				{Cwd: "primary", Args: []string{"branch", "feature"}},
				{Cwd: "primary", Args: []string{"push", "-q", "origin", "feature"}},
			},
			Operations: []fixtureOperation{
				{Op: "localBranches"},
				{Op: "currentBranch"},
				{Op: "status"},
				{Op: "listWorktrees"},
				{Op: "addWorktree", Branch: "feature"},
				{Op: "listWorktrees"},
				{Op: "removeWorktree", Branch: "feature"},
				{Op: "removeWorktree", Branch: "main"},
				{Op: "listWorktrees"},
			},
		},
		{
			Case: "dirty-status",
			Note: "working-tree status counts for added, changed and removed files",
			App: fixtureApp{
				Ident: "demo", RepositoryPath: "{{remote}}",
				LocalDirectoryPath: "primary", Branch: "main",
				MainWorktreeBranch: "main",
			},
			Setup: []fixtureSetup{
				{Cwd: "primary", Args: []string{"init", "-q", "-b", "main"}},
				{Cwd: "primary", Write: map[string]string{"keep.txt": "keep\n", "change.txt": "one\n", "gone.txt": "gone\n"}},
				{Cwd: "primary", Args: []string{"add", "."}},
				{Cwd: "primary", Args: []string{"commit", "-q", "-m", "init"}},
				{Cwd: "primary", Write: map[string]string{"change.txt": "two\n", "added.txt": "new\n"}},
				{Cwd: "primary", Args: []string{"rm", "-q", "gone.txt"}},
			},
			Operations: []fixtureOperation{
				{Op: "status"},
				{Op: "currentBranch"},
			},
		},
		{
			Case: "uncloned",
			Note: "unmaterialized checkout reports the placeholder status and empty reads",
			App: fixtureApp{
				Ident: "demo", RepositoryPath: "{{remote}}",
				LocalDirectoryPath: "primary", Branch: "main",
				MainWorktreeBranch: "main",
			},
			Setup: []fixtureSetup{},
			Operations: []fixtureOperation{
				{Op: "status"},
				{Op: "currentBranch"},
				{Op: "localBranches"},
				{Op: "listWorktrees"},
			},
		},
		{
			Case: "remote-sync",
			Note: "remote branch listing, fetch, pull and already-up-to-date push",
			App: fixtureApp{
				Ident: "demo", RepositoryPath: "{{remote}}",
				LocalDirectoryPath: "primary", Branch: "main",
				MainWorktreeBranch: "main",
			},
			Setup: []fixtureSetup{
				{Cwd: "remote", Args: []string{"init", "-q", "--bare", "-b", "main"}},
				{Cwd: "primary", Args: []string{"init", "-q", "-b", "main"}},
				{Cwd: "primary", Write: map[string]string{"README.md": "hello\n"}},
				{Cwd: "primary", Args: []string{"add", "README.md"}},
				{Cwd: "primary", Args: []string{"commit", "-q", "-m", "init"}},
				{Cwd: "primary", Args: []string{"remote", "add", "origin", "{{remote}}"}},
				{Cwd: "primary", Args: []string{"push", "-q", "-u", "origin", "main"}},
				// A second clone advances the remote so a fetch/pull has work to do.
				{Cwd: "other", Args: []string{"clone", "-q", "{{remote}}", "."}},
				{Cwd: "other", Write: map[string]string{"next.txt": "next\n"}},
				{Cwd: "other", Args: []string{"add", "next.txt"}},
				{Cwd: "other", Args: []string{"commit", "-q", "-m", "next"}},
				{Cwd: "other", Args: []string{"push", "-q", "origin", "main"}},
			},
			Operations: []fixtureOperation{
				{Op: "remoteBranches", RepoURL: "{{remote}}"},
				{Op: "fetch"},
				{Op: "pull"},
				{Op: "headFile", Branch: "primary"},
				{Op: "localBranches"},
			},
		},
		{
			Case: "checkout-new-branch",
			Note: "checkout of a branch that exists only on the remote creates a tracking branch",
			App: fixtureApp{
				Ident: "demo", RepositoryPath: "{{remote}}",
				LocalDirectoryPath: "primary", Branch: "main",
				MainWorktreeBranch: "main",
			},
			Setup: []fixtureSetup{
				{Cwd: "remote", Args: []string{"init", "-q", "--bare", "-b", "main"}},
				{Cwd: "primary", Args: []string{"init", "-q", "-b", "main"}},
				{Cwd: "primary", Write: map[string]string{"README.md": "hello\n"}},
				{Cwd: "primary", Args: []string{"add", "README.md"}},
				{Cwd: "primary", Args: []string{"commit", "-q", "-m", "init"}},
				{Cwd: "primary", Args: []string{"remote", "add", "origin", "{{remote}}"}},
				{Cwd: "primary", Args: []string{"push", "-q", "-u", "origin", "main"}},
				{Cwd: "primary", Args: []string{"push", "-q", "origin", "main:remote-only"}},
			},
			Operations: []fixtureOperation{
				{Op: "checkout", Branch: "remote-only"},
				{Op: "currentBranch"},
				{Op: "localBranches"},
			},
		},
	}
}
