## Why

The agent-dash overview panel currently spends seven vertical rows (BRANCH, CHANGED, NEW, DELETED, AHEAD, BEHIND) on git status. The developer wants all of that information condensed into a single compact line so the overview panel wastes less vertical space while still showing every field.

## What Changes

- Replace the labeled multi-row git status block in the overview panel with one horizontal row following the format `+{new}*{changed}-{deleted} ↑{ahead} ↓{behind} {branch}`.
- Color the segments: new count green (`uiColors.success`), changed count yellow (`uiColors.warning`), deleted count red (`uiColors.error`), ahead and behind green, branch name in regular secondary text.
- Always show all counts including zeros so no information is lost versus today's display.
- When there is no usable upstream, replace the two arrow segments with a single muted `no upstream` segment instead of duplicating the text twice.
- Keep the existing `GIT STATUS` header and the unavailable-worktree diagnostic fallback unchanged; no changes to data inspection (`data.ts`).
- Update the dashboard interaction tests that assert on the removed CHANGED/NEW/DELETED/AHEAD/BEHIND labels to assert on the compact format at normal and narrow widths.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `dashboard-overview-git-status`: The presentation requirement changes from distinct labeled rows for changed/new/deleted counts plus ahead/behind rows to a single compact status line (`+new*changed-deleted ↑ahead ↓behind branch`) with color-coded segments; the no-upstream indication becomes a single inline segment rather than two separate rows. Data semantics (counts, upstream exclusion, diagnostics, refresh) are unchanged.

## Impact

- `agentic-coding/src/tui/dash/App.tsx` — overview panel GIT STATUS section JSX (~lines 2229–2291) replaced by a single colored row.
- `agentic-coding/test/dash/userActions.test.tsx` — assertions updated from old field labels to the compact format.
- No API or data-model changes: `WorktreeGitStatus` already exposes every needed field (`addedFiles`, `changedFiles`, `deletedFiles`, `ahead`, `behind`, `noUpstream`, `branch`).
