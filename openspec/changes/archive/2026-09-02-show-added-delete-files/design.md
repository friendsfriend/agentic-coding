## Context

See proposal.md — Why. `loadLocalChanges` in `agentic-coding/src/tui/dash/data.ts` builds the developer-review changed-files list. Tracked changes come from `git diff --name-status`/`--numstat` against the base commit; untracked files are added by scanning `git status --short` for `??` lines and running `git diff --no-index /dev/null <path>` for the `+` count. `git status --short` (without `-uall`) collapses an untracked directory to one `?? dir/` entry, and passing that directory to `git diff --no-index` errors, so files inside a new directory are dropped.

A working reference already exists in the same file: `worktreeGitStatus` uses `git -c core.quotePath=false status --porcelain=v1 -b -uall`, which expands untracked directories into individual file entries.

## Goals / Non-Goals

**Goals:**
- Untracked files inside newly created directories appear individually in the developer-review changed-files list and each opens a valid per-file diff.
- Reuse the established `-uall` (and quote-path-safe) status invocation pattern already proven by `worktreeGitStatus`.

**Non-Goals:**
- No changes to plan review or wiki review file lists (developer decision: narrow scope).
- No new file-type detection UI or change to the row rendering contract beyond listing the additional files.

## Decisions

- **Expand untracked directories with `-uall`.** Change the untracked scan in `loadLocalChanges` to request all untracked files (e.g. `git status --short -uall`, matching the `-uall` behavior `worktreeGitStatus` already relies on) so each untracked file is its own entry. Alternative considered: `git ls-files --others --exclude-standard`, which also lists per-file; rejected to stay consistent with the existing `git status`-based parsing in this function and its `?? `-prefixed line handling.
- **Per-file untracked diff is already correct.** With individual file paths, the existing `git diff --no-index /dev/null <file>` call in both `loadLocalChanges` (numstat) and `loadLocalDiff` receives real files, not directories, so the directory-path error disappears without further change. Keep quote-path handling consistent so paths with special characters are not mangled (mirror `core.quotePath=false` as used by `worktreeGitStatus`).
- **Preserve existing exclusions and ordering.** The `.herdr-workflow` metadata skip, the `changes.has(path)` de-dup against tracked entries, and the final sort by `newPath` stay as-is.

## Risks / Trade-offs

- [Large untracked directories could enlarge the list] → Acceptable: reviewers need to see all added files; this matches the overview git-status counts which already use `-uall`.
- [Quoted/special-character paths from `git status`] → Mitigate by using the same quote-path-safe invocation as `worktreeGitStatus` so parsing of the `?? ` lines stays correct.

## Migration Plan

No data migration. Pure behavior fix in the dashboard data layer; no rollback steps beyond reverting the code change.
