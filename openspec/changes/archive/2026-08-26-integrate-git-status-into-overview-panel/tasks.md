## 1. Expose the complete Git status snapshot

- [x] 1.1 Extend the detail dashboard data contract to expose the structured `WorktreeGitStatus` values needed by the overview: changed, added/new, deleted, branch, availability/diagnostic, and optional ahead/behind counts.
- [x] 1.2 Update `loadDashboard` and the demo dashboard fixture to populate that contract from one `worktreeGitStatus` snapshot, preserving metadata exclusion, path de-duplication, and undefined divergence for missing upstreams.

## 2. Consolidate the dashboard layout and interactions

- [x] 2.1 Render a compact Git status section in the primary Change/overview panel showing separate changed, new, deleted, ahead, and behind values, with explicit no-upstream and unavailable-diagnostic states.
- [x] 2.2 Remove the standalone Git status panel and its layout row, remove panel index `4` from Tab/Shift-Tab navigation, and remove the panel-specific Enter handler without changing existing review-modal entry points.
- [x] 2.3 Keep the consolidated status bounded and compatible with the existing detail grid at normal and narrow terminal widths, including preserving navigation for Change, OpenSpec, Agents, and Current task.

## 3. Update focused coverage

- [x] 3.1 Add or update data tests for overview status mapping, clean and dirty file-count display data, usable upstream ahead/behind values, no-upstream/unavailable states, and workflow-metadata exclusion.
- [x] 3.2 Update dashboard UI and interaction tests to assert the overview contains the Git summary, the separate panel is absent, and the reduced focus order no longer exposes a Git-panel action.
- [x] 3.3 Add a narrow-width rendering assertion that the consolidated Git summary remains within the overview panel without horizontal overflow.

## 4. Validate

- [x] 4.1 Run the focused dashboard/data test suite and confirm all new and updated scenarios pass.
- [x] 4.2 Run `bun run lint` and `bun run type-check` from `agentic-coding/` and resolve any diagnostics introduced by the change.
