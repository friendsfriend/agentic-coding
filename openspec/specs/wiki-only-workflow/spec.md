# wiki-only-workflow Specification

## Purpose
TBD - created by archiving change wiki-only-workflow. Update Purpose after archive.
## Requirements
### Requirement: Repository-backed documentation workflow
The system SHALL provide a versioned `wiki` workflow that requires a source repository for evidence and whose only user-owned content output is the centralized wiki. The workflow SHALL use the repository checkout in checkout mode without creating or switching a branch or worktree, SHALL not require OpenSpec artifacts or a clean working tree, and SHALL preserve existing source content.

#### Scenario: Repository is required
- **WHEN** `wiki` is started without a valid source repository
- **THEN** startup SHALL fail before workspace or agent effects are launched

#### Scenario: Existing checkout supplies evidence
- **WHEN** `wiki` starts for a valid repository on a named branch
- **THEN** the workflow SHALL use that checkout as read-only evidence context and SHALL not create or switch a Git branch or worktree

#### Scenario: Dirty checkout is accepted
- **WHEN** the selected source repository already has tracked or untracked changes
- **THEN** `wiki` SHALL preserve those changes as its baseline and SHALL not reject startup solely because the checkout is dirty

#### Scenario: OpenSpec is not required
- **WHEN** a valid source repository has no `openspec/config.yaml`
- **THEN** `wiki` SHALL still be startable because its output is wiki documentation rather than an OpenSpec change

### Requirement: Documentation-only graph
The `wiki` definition SHALL contain `core.wiki`, `core.wiki-approval`, `core.completed`, and `core.closed` in that order, with `core.wiki` as its initial step and `core.closed` as its terminal step. Its reachable graph SHALL contain no implementation, triage, verification, archive, delivery, pull-request, or other code-changing workflow step or effect.

#### Scenario: Documentation reaches approval
- **WHEN** the wiki agent completes a valid documentation run
- **THEN** the workflow SHALL transition from `core.wiki` to `core.wiki-approval`

#### Scenario: Documentation retry is bounded
- **WHEN** the wiki agent submits a blocked or failed outcome
- **THEN** the workflow SHALL retry `core.wiki` only within its registered bounded retry limit and SHALL require operator attention after exhaustion

#### Scenario: Approval completes the documentation workflow
- **WHEN** the developer approves the reviewed wiki changes
- **THEN** the workflow SHALL enqueue the engine-owned wiki verification effect and transition to `core.completed`
- **AND** it SHALL not enter archive, delivery, implementation, verification, or pull-request steps

#### Scenario: Wiki comments return to documentation
- **WHEN** the developer submits review comments at `core.wiki-approval`
- **THEN** the workflow SHALL return to `core.wiki` with the bounded comments context available to the same documentation role

#### Scenario: Code-changing paths are unreachable
- **WHEN** the registry validates the `wiki` definition
- **THEN** the definition SHALL have no reachable `core.implementation`, `core.triage`, `core.verification`, `core.archive`, `core.delivery`, or pull-request effect path

### Requirement: Source isolation during documentation
The `wiki-only` documentation run SHALL permit repository reads and centralized wiki writes but SHALL not accept completion when source-repository content differs from the source baseline captured at startup. The comparison SHALL preserve pre-existing dirty content and SHALL ignore only engine-owned workflow bookkeeping and the centralized wiki output.

#### Scenario: Wiki write is accepted
- **WHEN** the wiki agent writes or updates concepts through the authenticated wiki command and leaves source content at its baseline
- **THEN** the wiki run SHALL be eligible for normal handoff and review

#### Scenario: Source mutation blocks completion
- **WHEN** source-repository tracked, staged, or untracked content differs from the captured baseline at wiki completion
- **THEN** the workflow SHALL reject successful completion or enter a bounded attention state with a source-isolation diagnostic
- **AND** it SHALL not present the run as an approved documentation-only result

#### Scenario: Pre-existing changes are preserved
- **WHEN** the source repository is dirty before startup and remains unchanged during the run
- **THEN** the workflow SHALL accept the unchanged baseline rather than requiring a clean tree

### Requirement: Documentation use cases receive task context
The workflow SHALL accept a non-empty documentation task describing the requested knowledge scope, including repository initialization, documentation of an undocumented feature, or addition of business information to existing concepts. The task SHALL be delivered to the wiki agent as assignment context together with the required source repository and centralized wiki scope.

#### Scenario: Repository initialization task
- **WHEN** a user starts `wiki-only` with a task to initialize documentation for an existing repository
- **THEN** the wiki agent SHALL receive the task and repository evidence scope and SHALL be able to create draft concepts without modifying source files

#### Scenario: Undocumented feature task
- **WHEN** a user starts `wiki-only` with a task naming an undocumented feature
- **THEN** the wiki agent SHALL receive the task and SHALL document the feature in the centralized wiki rather than implementing it

#### Scenario: Business information task
- **WHEN** a user starts `wiki-only` with a task to add business information to existing documentation
- **THEN** the wiki agent SHALL receive the task and SHALL update the intended wiki concepts in place when appropriate

### Requirement: Workflow is exposed consistently
The CLI and dashboard SHALL expose `wiki` as a selectable workflow, route its agent step to the `wiki` role, require repository-backed checkout semantics, and avoid offering implementation, delivery, archive, or pull-request actions for it. Help and start validation SHALL identify the workflow and its repository-evidence-only behavior.

#### Scenario: CLI starts wiki-only
- **WHEN** the CLI receives a valid `wiki` start request with a repository and task
- **THEN** it SHALL resolve and pin the `wiki` definition and launch only its registered documentation lifecycle

#### Scenario: Unsupported mode is rejected
- **WHEN** `wiki` is started in worktree mode or without the required repository/branch context
- **THEN** startup SHALL fail before workspace or agent effects are launched

#### Scenario: Dashboard offers wiki-only
- **WHEN** a developer opens the new-workflow dashboard flow
- **THEN** the workflow choices SHALL include a documentation-specific `Wiki` option with its description and repository-required guidance

#### Scenario: No code delivery action is exposed
- **WHEN** a `wiki` workflow is at approval or completion
- **THEN** available actions SHALL be limited to wiki review/approval, explicit close, and lifecycle recovery actions
- **AND** implementation, archive, delivery, and pull-request actions SHALL not be offered
