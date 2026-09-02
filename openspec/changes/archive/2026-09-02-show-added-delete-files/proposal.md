## Why

In the dashboard developer-review popup, added/deleted files that Git does not yet track are not always shown, so reviewers cannot see or comment on the full set of changes. `loadLocalChanges` collects untracked files via `git status --short`, which collapses an untracked *directory* into a single `?? dir/` entry; that directory path then flows into `git diff --no-index /dev/null dir/`, which errors, so files created inside a new directory never appear in the review.

## What Changes

- Enumerate untracked files individually (all files inside new directories) when building the developer-review changed-files list, instead of collapsing them to a single directory entry, so every added file is listed and reviewable.
- Ensure each individually enumerated untracked file resolves to a valid per-file diff in the review diff view.
- Keep already-working cases unchanged: tracked modifications, tracked deletions, tracked renames, root-level untracked files, and the `.herdr-workflow` metadata exclusion.

## Capabilities

### New Capabilities
<!-- None: this modifies existing developer-review behavior. -->

### Modified Capabilities
- `dashboard-developer-review-popup`: the changed-files list requirement is extended so untracked files nested inside newly created directories are enumerated individually and each is reviewable with a per-file diff.

## Impact

- Code: `agentic-coding/src/tui/dash/data.ts` — `loadLocalChanges` (untracked-file enumeration) and, if needed, `loadLocalDiff` (per-file untracked diff resolution).
- Tests: `agentic-coding/test/dash/data.test.ts` — add coverage for untracked files inside a new directory.
- No API, dependency, or schema changes. Behavior is confined to the dashboard developer-review changed-files/diff surface.
