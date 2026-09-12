# Using Worktrees

Worktree mode gives each branch its own directory, so you can switch instantly and work on multiple branches simultaneously.

## 1. Single checkout vs worktrees

By default, DevEnv manages one checkout per repository — switching branches modifies the working tree in-place. **Worktree mode** gives each branch its own permanent directory:

```
$DEVENV_HOME/
  my-app/
    my-app/                    ← primary worktree
    my-app.feature-login/      ← linked worktree
    my-app.hotfix-auth/        ← linked worktree
```

Benefits:
- IDE configuration (`.idea/`, `.vscode/`) survives branch switches
- Multiple branches can be built, run, or inspected in parallel
- Instant switching — no git checkout when the worktree already exists

## 2. Prerequisites

Worktree mode requires **[worktrunk](https://worktrunk.dev)** (`wt`):

```bash
brew install worktrunk
wt config shell install   # enables automatic directory switching
```

## 3. Enable worktree mode

Set `"gitMode": "WORKTREE"` in the repository definition JSON at `~/.config/devenv/apps/definitions/IDENT.json` or `~/.config/devenv/libraries/definitions/IDENT.json`.

Repositories added through the TUI use single-checkout branch mode by default. To enable worktrees for those repositories, edit the definition JSON and restart DevEnv.

## 4. Switching branches

Open the branch selector with `g` in the TUI, pick a branch, and press `Enter`:

- If the branch already has a worktree, DevEnv switches instantly
- If not, worktrunk creates the directory and checks out the branch

The active branch is shown with a `[WT]` prefix, e.g. `[WT] feature/login`.

## 5. IDE setup

Each worktree starts as a fresh directory without `.idea/`. To carry IntelliJ config across automatically, add a `post-start` hook in the repo's `.config/wt.toml`:

```toml
[post-start]
copy-config = "wt step copy-ignored"
```

Commit this file to the repo — worktrunk runs the hook when creating new worktrees, copying gitignored files from the source worktree.

## 6. Managing worktrees

- Press `w` in the TUI to open the worktree manager
- Press `n` to create a new worktree from the branch selector
- Press `d` to delete the selected worktree
- Press `Enter` to switch to a worktree

## 7. Removing a repository

Press `-` in the TUI to remove a repository. This deletes the entire repository directory including all worktrees.

See the [worktrunk documentation](https://worktrunk.dev) for advanced configuration.
