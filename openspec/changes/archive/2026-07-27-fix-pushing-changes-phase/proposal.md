# Fix stuck committing phase after git operations complete

## Problem

When `_start_git_operations` runs, it transitions phase `archive → committing → completed`. Three bugs prevent `completed` from persisting:

1. **Non-atomic state.json writes** — `save_state` uses `path.write_text()` which is not atomic. If the process crashes during a write, state.json is corrupted. Dashboard's `JSON.parse()` fails → catches error → shows stale data (last good read was "committing"). User sees "Pushing changes" permanently.

2. **Rollback undoes completed phase** — `_start_git_operations` captures `previous_phase` ("archive") before the try block. If `_complete_git_operations` successfully saves "completed" via `change_phase` but `finalize_workspace_trace` (or any later step) throws, the except handler restores `previous_phase` to "archive" — overwriting the correct "completed" state. The commit/push already happened.

3. **No dashboard recovery for stuck phases** — `approvalFor()` has no entry for "archive" or "committing". If phase gets stuck, Enter key does nothing. No way to advance.

Also: `cmd_archive`'s "committing" branch calls `_complete_git_operations` without try-except. If it fails (dirty tree on retry), phase stays "committing".

## Solution

### 1. Atomic state.json writes
Write to `.tmp` file first, then `rename()` (atomic on POSIX). Prevents corruption from partial writes.

### 2. Don't roll back completed
In `_start_git_operations` except handler: if current phase is already "completed" (set by `_complete_git_operations`), skip the restore. The commit/push already happened — no reason to revert phase.

### 3. Dashboard gates for stuck phases
Add `approvalFor` entries for "archive" (Enter → run archive command) and "committing" (Enter → run `_complete_git_operations`). Allows manual recovery if automatic transition fails.

### 4. Protect cmd_archive committing path
If phase is "committing" and `_complete_git_operations` finds a clean tree (work already done), transition to "completed" instead of raising `SystemExit`.

## Non-goals

- Not changing the module/transition graph
- Not adding new phases
- Not changing how archive agent works
