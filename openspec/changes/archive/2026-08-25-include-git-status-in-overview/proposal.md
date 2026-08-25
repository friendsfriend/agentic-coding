## Why

The workspace overview currently shows workflow entries but gives no indication of the repository's working-tree or branch state. Users must open a workflow dashboard (or an external Git tool) to discover changed files and whether the current branch is ahead of or behind its upstream.

## What Changes

- Add a Git status panel to the workspace overview for the selected repository/workspace.
- Show counts of changed, added, and deleted files, plus commits ahead of and behind the upstream branch.
- Add a `G` overview action that opens the existing changed-files view for the selected workspace.
- Reuse the current changed-files interaction and diff behavior rather than introducing a second file-review implementation.
- Display a useful empty, unavailable, or no-upstream state when Git data cannot be calculated.

## Capabilities

### New Capabilities

- `workspace-overview-git-status`: Expose repository Git status metrics in the overview and provide access to changed files for the selected workspace.

### Modified Capabilities

## Impact

- Affected dashboard overview UI and its keyboard help/keymap.
- Workspace overview data loading and refresh behavior, including Git inspection for the selected repository/worktree.
- Existing changed-files modal/view integration and related dashboard tests.
- No external API or persisted workflow-state changes are expected.
