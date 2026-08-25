## 1. Git status data

- [x] 1.1 Define the overview Git-status result shape, including branch, changed/added/deleted file counts, ahead/behind counts, no-upstream state, and bounded unavailable diagnostics.
- [x] 1.2 Implement shared worktree Git inspection using porcelain status and upstream `rev-list` counts, deduplicating paths and classifying modified, added, deleted, renamed, and untracked entries consistently.
- [x] 1.3 Attach Git status to each `WorkflowOverview` during `listWorkflows()` refresh and reuse the shared inspection for detail-dashboard health without persisting metrics.
- [x] 1.4 Add data tests covering clean worktrees, modified/added/deleted files, untracked and renamed paths, ahead/behind counts, missing upstreams, and unavailable worktrees.

## 2. Shared changed-files interaction

- [x] 2.1 Extract the existing changed-files list-to-diff modal boundary so it can be opened by both the detail Git panel and the home overview while preserving `ChangedFilesView` rendering and navigation.
- [x] 2.2 Keep developer-review-only behavior (findings, comments, review completion, and phase gating) in the detail dashboard and verify the extraction does not change its existing Enter/Escape behavior.

## 3. Workspace overview UI

- [x] 3.1 Add a compact Git status panel to `Home` for the selected workspace, showing branch and labeled changed, added, deleted, ahead, and behind values, plus no-selection, no-upstream, and unavailable states.
- [x] 3.2 Add the `G` overview keybinding and help entry; load changed files for the selected workflow and open the shared changed-files interaction, leaving the overview usable when no workspace is selected or loading fails.
- [x] 3.3 Ensure normal overview refreshes update the selected workspace's Git status and retain existing workspace selection, modal priority, and navigation behavior.

## 4. Integration coverage and gates

- [x] 4.1 Add dashboard UI tests for overview status rendering, `G` opening changed files, Enter opening a diff, Escape returning to the list, and the empty/no-selection cases.
- [x] 4.2 Run the relevant dashboard tests plus `bun run type-check` and `bun run lint`, fixing any regressions without changing unrelated workflow behavior.
