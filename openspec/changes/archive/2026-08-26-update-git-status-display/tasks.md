## 1. Overview panel status line

- [x] 1.1 In `agentic-coding/src/tui/dash/App.tsx` (~lines 2229–2291), replace the BRANCH/CHANGED/NEW/DELETED/AHEAD/BEHIND rows with a single `<box flexDirection="row" overflow="hidden">` (no gap) wrapped in the existing `Show when={data().gitStatus.branch}` guard
- [x] 1.2 Render segments as adjacent `<text>` nodes: `+addedFiles` in `uiColors.success`, `*changedFiles` in `uiColors.warning`, `-deletedFiles` in `uiColors.error`; then either `↑ahead` and `↓behind` in `uiColors.success` or a single muted `no upstream` segment when `gitStatus.noUpstream`; end with branch name in `uiColors.textSecondary`
- [x] 1.3 Leave the `GIT STATUS` header and the unavailable-worktree diagnostic fallback unchanged; verify no changes are needed in `src/tui/dash/data.ts`

## 2. Test updates

- [x] 2.1 Update "overview contains Git status…" in `agentic-coding/test/dash/userActions.test.tsx`: replace `toContain("CHANGED"/"NEW"/"DELETED"/"AHEAD"/"BEHIND")` assertions with compact-format assertions (`GIT STATUS`, `+0*0-0`, `↑0`, `↓0`, mocked branch `feature/demo-optional-realisation-date`) keeping `not.toContain("clean ·")`
- [x] 2.2 Update "overview Git summary stays within the panel at a narrow width": keep the ≤50-chars-per-line assertion, swap CHANGED/DELETED contains-checks for compact markers confirming the row fits without wrapping

## 3. Validation

- [x] 3.1 Run the dash tests (`bun test test/dash/userActions.test.tsx`) and confirm all pass
- [x] 3.2 Run type check and lint (`bun run type-check`, `bun run lint`) from `agentic-coding/` and resolve any diagnostics
