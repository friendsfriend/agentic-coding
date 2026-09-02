## 1. Implementation

- [x] 1.1 In `agentic-coding/src/tui/dash/data.ts`, update the untracked-file scan in `loadLocalChanges` to enumerate untracked files individually — request all untracked files (add `-uall`) and use the quote-path-safe invocation used by `worktreeGitStatus` (`-c core.quotePath=false`) — so files inside a newly created directory each become their own `?? <file>` entry. Preserve the `.herdr-workflow` exclusion, the `changes.has(path)` de-dup, and the final sort. Verify by adding a file inside a new directory and confirming it appears as its own added-file row.
- [x] 1.2 Confirm per-file untracked diffs resolve for nested files: the `git diff --no-index /dev/null <file>` calls in `loadLocalChanges` (numstat) and `loadLocalDiff` now receive individual file paths, not a directory. Verify `loadLocalDiff` returns the added content (no directory-path error) for an untracked file inside a new directory.

## 2. Tests

- [x] 2.1 In `agentic-coding/test/dash/data.test.ts`, extend the `loadLocalChanges`/`loadLocalDiff` coverage with an untracked file nested inside a newly created directory (for example `newdir/sub/added.ts`), asserting it is listed as an individual added-file row with a `+` count and that its diff shows the added content. Verify the change-relevant tests pass: `bun test test/dash/data.test.ts`.
- [x] 2.2 Verify no regressions in existing behavior covered by the same test file (tracked modifications, tracked deletions/renames, root-level untracked files, and `.herdr-workflow` exclusion) by running `bun test test/dash/data.test.ts` and confirming previously passing cases still pass.

## 3. Validation

- [x] 3.1 Run `bun run lint` and `bun run type-check` from `agentic-coding/` and confirm zero diagnostics.
