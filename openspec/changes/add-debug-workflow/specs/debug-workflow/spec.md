# Spec Delta

## Purpose

A standalone workflow in which a debug agent investigates behavior on a chosen
branch using environments, browser and debug tools, and reports with evidence
for developer review.

## ADDED Requirements

### Requirement: Debug workflow runs on a detached worktree

The `debug` family SHALL require a branch and a task, create a detached worktree at the branch head, and SHALL NOT create, switch or commit to any branch.

#### Scenario: Branch checked out elsewhere

- **WHEN** a debug workflow starts on the branch currently checked out in the main checkout
- **THEN** the workflow SHALL start in a detached worktree and the main checkout SHALL be unchanged

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

The `debug` family SHALL NOT contain archive, delivery or pull-request steps, and closing it SHALL tear down its instances.

#### Scenario: Close

- **WHEN** the developer closes a completed debug workflow
- **THEN** its instances SHALL be removed and no pull request SHALL exist
