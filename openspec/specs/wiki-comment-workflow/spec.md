# wiki-comment-workflow Specification

## Purpose
TBD - created by archiving change introduce-wiki-view. Update Purpose after archive.
## Requirements
### Requirement: Finished comments start a UI-only wiki workflow
The system SHALL provide an in-process workflow start operation callable only by the home UI that accepts one or more line-anchored wiki comments and creates a unique review workflow session. The new workflow SHALL not be exposed as a CLI workflow choice or as an option in the New Workflow modal.

#### Scenario: Finish starts a dedicated session
- **WHEN** the user presses `f` with at least one valid wiki comment
- **THEN** the home UI starts one dedicated wiki comment workflow and passes every comment to it
- **AND** the review session is marked as submitted so a repeated `f` cannot create a duplicate workflow

#### Scenario: UI-only workflow is not a public start option
- **WHEN** a user opens the CLI help or New Workflow modal workflow choices
- **THEN** the dedicated wiki comment workflow is absent
- **AND** the existing repository-backed `wiki-only` option remains unchanged

#### Scenario: Start failure preserves bounded feedback
- **WHEN** the workflow cannot be created or its initial agent effect cannot be queued
- **THEN** the UI reports the failure without claiming that comments were addressed
- **AND** the user can inspect or retry the review according to the current submission state without silently creating multiple sessions

### Requirement: Wiki comment workflows have no repository association
The dedicated workflow SHALL persist its state through an application-owned non-repository workflow target, use the resolved centralized wiki root as its work context, and omit source repository, branch, checkout, OpenSpec, and Git-baseline requirements. Its workflow metadata and dashboard representation SHALL not identify a repository as the source of the review.

#### Scenario: Start without a repository
- **WHEN** the UI starts a wiki comment workflow from a home shell that has no selected repository or workflow
- **THEN** startup succeeds using the centralized wiki target
- **AND** no repository validation, branch lookup, worktree creation, or OpenSpec validation is performed

#### Scenario: State survives UI refresh
- **WHEN** the home shell refreshes after submitting comments or is remounted while the session is active
- **THEN** the workflow can be located through its non-repository target and its current lifecycle state remains revision-bound
- **AND** the wiki view does not create another workflow for the same submitted review

#### Scenario: Existing wiki-only workflow is preserved
- **WHEN** a repository-backed `wiki-only` workflow is started through its existing CLI or New Workflow modal path
- **THEN** it continues to require repository evidence and checkout semantics
- **AND** its behavior is not changed by the new UI-only workflow target

### Requirement: The wiki agent receives review context in a wiki workspace
The workflow SHALL launch the configured `wiki` role through the existing authenticated agent adapter with its current working directory set to the centralized wiki root (or a workspace rooted there). The assignment SHALL include all submitted comments as untrusted developer-provided context, including each concept identifier, 1-based line or range, and body, and SHALL authorize only centralized wiki draft writes through the authenticated `core.wiki` capability.

#### Scenario: Agent is spawned in the wiki context
- **WHEN** a submitted UI-only workflow enters its wiki-agent step
- **THEN** a wiki agent is launched in a Herdr workspace/tab whose working context is the centralized wiki root
- **AND** the agent is not launched in a repository checkout or source worktree

#### Scenario: Comments are delivered with anchors
- **WHEN** the wiki agent receives the generated assignment
- **THEN** the assignment lists every submitted comment with its concept ID and current line/range anchor
- **AND** the comment text is explicitly treated as developer-provided context rather than executable instructions

#### Scenario: Agent writes only through the wiki capability
- **WHEN** the wiki agent addresses a comment
- **THEN** it may update centralized wiki concepts through the authenticated `core.wiki` writer path
- **AND** it cannot use the review workflow to write repository files, OpenSpec artifacts, or forged human verification metadata

### Requirement: Successful comment handling triggers wiki verification
After the wiki agent reports `complete`, the workflow SHALL enqueue the engine-owned `wiki.verify` effect for the concepts touched by the workflow and SHALL then expose normal completion state. The workflow SHALL not enqueue implementation, repository verification, archive, delivery, pull-request, or repository cleanup effects.

#### Scenario: Agent completion triggers verification
- **WHEN** the wiki agent completes after addressing the submitted comments
- **THEN** the workflow schedules `wiki.verify` against the pinned centralized wiki root and touched-concept set
- **AND** the verification runs without a repository or source baseline

#### Scenario: Verification promotes the updated concepts
- **WHEN** the engine-owned wiki verification succeeds
- **THEN** each touched concept receives the configured verification metadata and the workflow records successful completion
- **AND** concepts not touched by the workflow remain unchanged

#### Scenario: Verification detects concurrent changes
- **WHEN** a touched concept changes after the workflow's digest/snapshot point and before verification
- **THEN** verification fails with a clear stale-content diagnostic
- **AND** the workflow does not mark the review as successfully verified

#### Scenario: Code-changing effects are unreachable
- **WHEN** the registry validates the dedicated UI-only workflow definition
- **THEN** no implementation, triage, repository verification, archive, delivery, pull-request, or repository cleanup path is reachable

### Requirement: Agent failure and retry are bounded and observable
The workflow SHALL use bounded retry handling for blocked/failed wiki-agent and verification outcomes, expose its status to the home UI through the existing refresh/notification mechanisms, and retain the submitted comment context for retries. A retry SHALL reuse the same workflow session rather than silently starting a replacement.

#### Scenario: Blocked agent can retry within the limit
- **WHEN** the wiki agent reports blocked or failed before exhausting its configured retry limit
- **THEN** the workflow remains associated with the same review session and can retry the wiki step with the original comments
- **AND** the UI shows that the workflow requires attention or is retrying

#### Scenario: Retry exhaustion is visible
- **WHEN** the wiki-agent or verification retry limit is exhausted
- **THEN** the workflow enters its bounded attention/failed state with a diagnostic
- **AND** the UI does not report the comments as addressed

#### Scenario: Home UI refreshes workflow status
- **WHEN** the workflow revision, run status, or verification effect status changes
- **THEN** the home view refreshes or notifies from the canonical workflow state
- **AND** it does not infer success merely from an agent pane being present

### Requirement: Renamed internal wiki-comments definition
The UI-only wiki comment workflow SHALL use technical definition ID `wiki-comments` and UI label `Wiki Comments` in internal status and dashboard representations, while remaining unavailable as a CLI workflow flag and New Workflow modal choice.

#### Scenario: Comment review starts under the renamed definition
- **WHEN** the home UI starts a dedicated wiki comment review session
- **THEN** the persisted workflow SHALL use definition ID `wiki-comments`
- **AND** the workflow SHALL retain its existing centralized-wiki, comment-context, verification, retry, and completion behavior

#### Scenario: Comment review remains UI-only
- **WHEN** a user opens CLI help or New Workflow modal workflow choices
- **THEN** `wiki-comments` SHALL be absent from both public start surfaces
- **AND** the repository-backed `wiki` choice SHALL remain independently available
