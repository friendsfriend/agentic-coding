## ADDED Requirements

### Requirement: Untracked files inside new directories are individually reviewable
The developer-review changed-files list SHALL enumerate every untracked (not-yet-Git-tracked) file individually, including files nested inside newly created directories, rather than collapsing a new directory into a single directory entry. Each enumerated untracked file SHALL be classified as an added file with its `+` change count and SHALL resolve to a valid per-file diff when opened. The `.herdr-workflow` metadata path SHALL remain excluded, and existing tracked-file behavior (modifications, deletions, renames, and root-level untracked files) SHALL be unchanged.

#### Scenario: New file inside a new directory is listed
- **WHEN** the developer-review changed-files list is built for a worktree containing an untracked file inside a directory that does not yet exist in Git (for example `newdir/sub/added.ts`)
- **THEN** that file appears as its own added-file row with its `+` change count, not as a single directory entry

#### Scenario: Diff opens for an untracked file inside a new directory
- **WHEN** the user opens the diff for an untracked file that lives inside a newly created directory
- **THEN** the diff view shows that file's added content instead of an error or empty diff

#### Scenario: Multiple untracked files in a new directory each appear
- **WHEN** a newly created directory contains more than one untracked file
- **THEN** each untracked file appears as its own added-file row

#### Scenario: Existing tracked and metadata behavior is preserved
- **WHEN** the changed-files list is built for a worktree with tracked modifications, tracked deletions, tracked renames, and root-level untracked files, alongside the `.herdr-workflow` metadata directory
- **THEN** tracked changes and root-level untracked files are listed as before and the `.herdr-workflow` metadata path is excluded
