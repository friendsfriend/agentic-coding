# debug-workflow Specification

## Purpose
TBD - created by archiving change add-debug-workflow. Update Purpose after archive.
## Requirements
### Requirement: Debug workflow runs on a detached worktree

The `debug` family SHALL require a branch and a task, create a detached worktree at the branch head, and SHALL NOT create, switch or commit to any branch. Setting that worktree up SHALL tolerate what an earlier workflow on the same branch left at the target path: a stale git registration SHALL be pruned, a directory holding nothing but the engine's own `.herdr-workflow` data SHALL be reclaimed, and any other content SHALL fail the setup with a message naming the path and what it holds, never being deleted.

#### Scenario: Branch checked out elsewhere

- **WHEN** a debug workflow starts on the branch currently checked out in the main checkout
- **THEN** the workflow SHALL start in a detached worktree and the main checkout SHALL be unchanged

#### Scenario: A second debug workflow on the same branch

- **WHEN** a debug workflow on branch `develop` closes and a later one starts on `develop`
- **THEN** the second SHALL set its worktree up successfully, whatever the first workflow's telemetry writes left behind

#### Scenario: A leftover directory with content

- **WHEN** the target path exists, is not a registered worktree, and holds files that are not the engine's own harness data
- **THEN** the setup SHALL fail naming the path and the entries it holds, and SHALL NOT delete anything

### Requirement: A closed workflow's telemetry never recreates its workspace

A telemetry write whose directory lives inside a workspace that no longer exists SHALL be dropped instead of creating that directory: a closed worktree-mode workflow is removed by `workspace.cleanup`, and an observation of that same command (or a runtime bridge envelope that lands later) must not bring the worktree path back.

#### Scenario: The cleanup command is observed after the worktree is gone

- **WHEN** `workspace.cleanup` removes the workflow's worktree and its own telemetry envelope is emitted afterwards
- **THEN** the removed worktree path SHALL NOT exist again, and the next workflow on that branch SHALL set its worktree up without `fatal: '<path>' already exists`

### Requirement: Investigation ends in a structured report

The debug agent SHALL complete only with a `debug-report.md` containing summary, environment, reproduction steps, expected versus actual, findings referencing evidence ids, code changes and open questions; code edits SHALL be preserved as `changes.patch` evidence.

#### Scenario: Agent edited code

- **WHEN** the debug agent hands off with modified files
- **THEN** a `changes.patch` evidence entry containing the diff SHALL exist

### Requirement: Standalone reports wait for developer review

After investigation the workflow SHALL wait at `debug.review`; approve SHALL complete the workflow and follow-up SHALL return to investigation with the developer's comment, bounded to five rounds.

#### Scenario: Follow-up

- **WHEN** the developer requests a follow-up with a comment
- **THEN** a new investigation run SHALL start with the comment in its assignment

### Requirement: Debug workflows never deliver

The `debug` family SHALL NOT contain archive, delivery or pull-request steps, and closing it SHALL stop and release every app it holds.

#### Scenario: Close

- **WHEN** the developer closes a completed debug workflow
- **THEN** every app it held SHALL be stopped and released and no pull request SHALL exist

