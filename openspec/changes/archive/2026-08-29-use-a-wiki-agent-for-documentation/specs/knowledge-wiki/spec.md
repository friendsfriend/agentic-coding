## MODIFIED Requirements

### Requirement: Planning roles consult the wiki
The pinned instructions for the planning, fusion-planning, and fusion-consolidation steps SHALL direct the agent to consult the bundle before deciding, SHALL state that wiki access is exempt from the surrounding restrictions on exploration, and SHALL require the agent to weight a concept by its `status`, trust tier, and staleness rather than treating every concept as authoritative. The instructions SHALL require project-specific knowledge to use `projects/<project-id>/<concept>`, genuinely cross-project knowledge to use `shared/<concept>` only when evidence from each covered project is available, and repository-relative source paths to be interpreted in the context of the project whose concept is being documented rather than presented as universal facts. Planning, fusion-planning, and fusion-consolidation agents SHALL NOT write wiki concepts; they SHALL report useful documentation gaps in their planning output for the dedicated wiki documentation step.

#### Scenario: Planning instructions grant access
- **WHEN** the planning, fusion-planning, or fusion-consolidation instruction is rendered into an assignment
- **THEN** it instructs the agent to search and read the bundle and exempts that access from the scope restriction it would otherwise violate

#### Scenario: Trust signals are weighted
- **WHEN** a planning agent reads a concept
- **THEN** its instructions require treating an unverified draft, a deprecated concept, and a stale concept as weaker evidence than a verified stable one

#### Scenario: Namespace is selected from scope
- **WHEN** a planning role records or proposes knowledge specific to one project
- **THEN** its instructions direct it to use `projects/<project-id>/<concept>`, while a fact applying across multiple projects uses `shared/<concept>` only when evidence from each covered project is available

#### Scenario: Repository paths retain project context
- **WHEN** a concept cites a repository-relative path
- **THEN** the instructions require identifying the project context for that path and prohibit presenting the path as a universal location or rule

#### Scenario: Parallel planners report gaps instead of writing
- **WHEN** a planning or consolidation agent identifies missing or stale knowledge
- **THEN** it reports the gap in its plan risks or questions and does not invoke a wiki write operation

#### Scenario: Sequential planning roles may draft
- **WHEN** a sequential planning or consolidation agent identifies knowledge worth capturing
- **THEN** it leaves the documentation to the dedicated wiki role rather than writing a draft concept

### Requirement: Wiki approval gate precedes delivery
The system SHALL provide a developer-actor workflow step for wiki approval, positioned after the dedicated wiki documentation step and before the OpenSpec archive and delivery steps in every workflow definition that includes an archive step. The gate SHALL have the outcomes `approve` and `comments`. The approve outcome SHALL enqueue the engine-owned human-verification effect and proceed to archive; the comments outcome SHALL return to the dedicated wiki documentation step under a bounded loop. Definitions without an archive step SHALL NOT gain the documentation or wiki approval steps.

#### Scenario: Documentation precedes review and archive
- **WHEN** an archive-bearing workflow is registered
- **THEN** its reachable path contains the wiki documentation step, wiki approval gate, archive step, and delivery step in that order

#### Scenario: Approval promotes before archive
- **WHEN** the developer approves at the wiki approval gate
- **THEN** the engine promotes every touched concept through its human-verification effect and advances to OpenSpec archive

#### Scenario: Comments return to wiki documentation
- **WHEN** the developer submits comments at the wiki approval gate
- **THEN** the workflow returns to the wiki documentation step so the wiki agent can revise the documentation

#### Scenario: Definitions without archive are unaffected
- **WHEN** a workflow definition has no archive step
- **THEN** it contains neither the wiki documentation step nor the wiki approval step

#### Scenario: Approval proceeds to delivery
- **WHEN** the developer approves at the wiki approval gate
- **THEN** the workflow advances to the delivery step

#### Scenario: Comments return to the archive agent
- **WHEN** the developer submits comments at the wiki approval gate
- **THEN** the workflow returns to the archive step so the agent can revise

## REMOVED Requirements

### Requirement: Sequential planning roles author drafts
The system SHALL permit the `write` operation when `HERDR_ROLE` is unset or is a sequential planning role or the archive role, and SHALL reject it for any other role. For a non-archive role the system SHALL force `status` to `draft`, SHALL set `generated.by` from the writing role, and SHALL NOT write a `verified` field.

#### Scenario: Sequential planner writes a draft
- **WHEN** `write` runs with `HERDR_ROLE` set to the planner or consolidator role
- **THEN** the concept is installed with `status: draft`, a `generated.by` actor identifying that role, and no `verified` field

#### Scenario: Planner cannot self-verify
- **WHEN** a planner or consolidator write attempts to set `status: stable` or supply a `verified` value
- **THEN** the request is rejected or the value is forced back to a draft with no verification, and the stored concept remains unverified

#### Scenario: Parallel fusion planner may not write
- **WHEN** `write` runs with `HERDR_ROLE` set to a parallel fusion planner role
- **THEN** the operation exits non-zero with an error, and the bundle is unchanged

#### Scenario: Worker and verifier may not write
- **WHEN** `write` runs with `HERDR_ROLE` set to a worker, triage, or verifier role
- **THEN** the operation exits non-zero with an error, and the bundle is unchanged

#### Scenario: Human administration is permitted
- **WHEN** `write` runs with `HERDR_ROLE` unset
- **THEN** the concept is installed

**Reason**: Documentation is being moved out of incidental planning and archival responsibilities into a dedicated reviewed step.
**Migration**: Existing planner or consolidator writes remain readable, but new workflow agents use the dedicated wiki role and leave concepts unverified until the developer approval gate.

### Requirement: Archive role writes the wiki
The pinned archive instruction SHALL direct the agent, after a successful OpenSpec archive, to record durable cross-change knowledge from the landed change, to promote the drafts written during planning for that change, to update an existing concept in place rather than creating a near-duplicate, to mark a superseded concept deprecated rather than deleting it, to append a `log.md` entry, to list the touched concept identifiers in the run-bound archive evidence, and to state explicitly when a change produced no knowledge worth recording. The instruction SHALL require project-specific concepts to use `projects/<project-id>/<concept>`, shared concepts to use `shared/<concept>` only when their claims are evidenced by every covered project, and repository-relative source paths to be labeled with the project context. When migrating legacy `repository/*` concepts, the instruction SHALL move them to the corresponding project-scoped identifiers when a safe move is available; otherwise it SHALL leave the legacy documents explicitly deprecated and ensure only one active project-scoped concept remains. The instruction SHALL additionally direct the agent, when the gate returns the workflow with review comments, to read those comments from the run context, apply each to the concept it names, and record which comment each edit resolves.

#### Scenario: Archive promotes after a successful archive
- **WHEN** the archive step completes `openspec archive` successfully
- **THEN** its instructions require verifying the change's draft concepts and appending a log entry before handing off

#### Scenario: Superseded knowledge is deprecated, not deleted
- **WHEN** a landed change makes an existing concept obsolete
- **THEN** the archive instruction requires marking it `status: deprecated` rather than removing the document

#### Scenario: Review comments are applied on revision
- **WHEN** the wiki approval gate returns the workflow to the archive step with comments
- **THEN** the instruction requires reading the comments from the run context, applying each to the named concept, and stating which comment each edit resolves

#### Scenario: Archive does not re-archive on revision
- **WHEN** the archive step runs again after gate comments on an already-archived change
- **THEN** the instruction requires revising the wiki without repeating the OpenSpec archive

#### Scenario: Wiki failure does not block the archive
- **WHEN** a wiki write fails after the change has already been archived
- **THEN** the archive reports the exact wiki error in its evidence rather than reporting a blocked outcome

#### Scenario: No durable knowledge is stated explicitly
- **WHEN** a change produces no knowledge worth recording
- **THEN** the archive evidence states that no concept was written

#### Scenario: Shared claims have complete project evidence
- **WHEN** the archive records a concept under `shared/<concept>` covering multiple projects
- **THEN** its evidence identifies source resources from each covered project and does not rely on a path from one repository as a universal fact

#### Scenario: Legacy concepts are migrated without active duplicates
- **WHEN** a legacy `repository/<concept>` draft corresponds to Agentic Coding project knowledge
- **THEN** the archive moves it to `projects/agentic-coding/<concept>` with its required frontmatter, sources, body citations, and `status: draft` unchanged, or marks the legacy document `status: deprecated` when a safe move is unavailable, while retaining only the project-scoped document as active

**Reason**: The dedicated wiki agent now authors and revises documentation before archival; archive must remain an OpenSpec lifecycle step.
**Migration**: Keep existing concepts and the administrative wiki commands available, but remove wiki authoring, verification, and review duties from the pinned archive assignment. Human approval is the promotion boundary.

### Requirement: Archive agent survives the gate
No step between the archive step's completion and the resolution of the wiki approval gate SHALL be permitted to close or clean up the workspace, so the archive agent remains available to act on review comments. A comments outcome SHALL reuse the running archive agent rather than launching a replacement.

#### Scenario: No teardown before the gate resolves
- **WHEN** the workflow sits at the wiki approval gate
- **THEN** no step reached so far permits a workspace close or cleanup effect

#### Scenario: Revision reuses the live agent
- **WHEN** the gate returns the workflow to the archive step with comments
- **THEN** the still-running archive agent receives the work instead of a newly launched agent

**Reason**: Review comments now belong to the dedicated wiki documentation step, not the archive step.
**Migration**: Existing archived workflow state keeps its historical graph; new definitions route comments to the wiki role and launch that role with the review context.

### Requirement: Non-planning roles have no wiki exposure
The pinned instructions for the implementation, triage, and verification steps SHALL NOT reference the wiki, and wiki guidance SHALL NOT be added to any instruction asset shared with those steps.

#### Scenario: Worker and verifier prompts stay wiki-free
- **WHEN** the implementation, triage, or verification instructions are rendered into an assignment
- **THEN** no wiki command or wiki guidance appears in the assignment

**Reason**: A separate wiki documentation role is intentionally the only managed authoring prompt for workflow documentation.
**Migration**: Keep implementation, triage, and verification prompts wiki-free, and add any documentation-specific guidance only to the new wiki instruction asset.

## ADDED Requirements

### Requirement: Human review preserves the documentation agent's work
No step between the wiki documentation step's completion and the resolution of the wiki approval gate SHALL close or clean up the workspace. A comments outcome SHALL launch or resume the dedicated wiki role with the review context rather than routing to the archive role, and the documentation step SHALL revise wiki concepts without repeating any OpenSpec archival operation.

#### Scenario: No teardown before the gate resolves
- **WHEN** the workflow sits at the wiki approval gate
- **THEN** no step reached so far permits a workspace close or cleanup effect

#### Scenario: Revision receives review context
- **WHEN** the gate returns the workflow to the wiki documentation step with comments
- **THEN** the wiki role receives the bounded comments and their concept or line anchors as revision context

#### Scenario: Revision does not archive
- **WHEN** the wiki documentation step runs after review comments
- **THEN** it edits only the affected documentation and does not run the OpenSpec archive operation


### Requirement: Dedicated wiki role authors OKF drafts
The system SHALL provide a dedicated agent step and role for documentation in archive-bearing workflows. The wiki role SHALL inspect the change's available repository evidence and the centralized bundle, then write or update meaningful OKF v0.2 concept documents as unverified drafts using project-scoped identifiers, preserving unknown frontmatter fields and updating an existing concept in place rather than creating an active near-duplicate. Each authored concept SHALL include a non-empty type, title, description, source resources, and body content that explains durable facts with repository-relative citations qualified by project context. The role SHALL report the touched concept identifiers, or explicitly report that no durable knowledge was found, in its run-bound evidence.

#### Scenario: Wiki role writes a draft concept
- **WHEN** the dedicated wiki step identifies durable project knowledge
- **THEN** it writes or updates a concept under `projects/<project-id>/` with `status: draft`, generated provenance, sources, and no `verified` event

#### Scenario: Wiki role avoids duplicate concepts
- **WHEN** a related concept already exists in the centralized bundle
- **THEN** the wiki role updates the intended existing identifier after searching and reading candidates instead of creating an active near-duplicate

#### Scenario: Wiki role records no-op documentation
- **WHEN** the change contains no durable knowledge worth retaining
- **THEN** the wiki role writes no concept and its evidence explicitly states that no durable knowledge was found

#### Scenario: Draft content follows OKF shape
- **WHEN** a concept is authored by the wiki role
- **THEN** it is a valid UTF-8 Markdown concept with OKF v0.2-compatible frontmatter and meaningful body-level claims tied to source resources

### Requirement: Wiki authoring is isolated to the dedicated role
Managed workflow invocations SHALL permit wiki draft writes for the dedicated `wiki` role and SHALL reject wiki draft writes from planner, consolidator, fusion-planner, worker, triage, verifier, and archive roles. The dedicated role SHALL NOT be able to set a stable status or supply a machine or human verification event. The existing administrative `wiki verify` operation MAY set `status: stable` with a `process:herdr-archive` machine verification event, but SHALL reject human or arbitrary actors. Human-reviewed promotion SHALL remain an engine-owned effect of developer approval.

#### Scenario: Dedicated role is permitted to write
- **WHEN** `wiki write` runs with the managed `wiki` role
- **THEN** the concept is installed as an unverified draft

#### Scenario: Planning and archive roles cannot write
- **WHEN** `wiki write` runs with a managed planner, consolidator, or archive role
- **THEN** the operation exits non-zero and the bundle remains unchanged

#### Scenario: Other implementation roles cannot write
- **WHEN** `wiki write` runs with a managed worker, triage, verifier, or fusion-planner role
- **THEN** the operation exits non-zero and the bundle remains unchanged

#### Scenario: Wiki role cannot self-verify
- **WHEN** the dedicated wiki role attempts to set stable status or provide a verification actor
- **THEN** the operation rejects the request or stores only a draft without verification

#### Scenario: Administrative process verification remains machine-confirmed
- **WHEN** an unmanaged administrator or archive role invokes `wiki verify` with a `process:` actor
- **THEN** the operation records that process verification and sets `status: stable` with machine-confirmed trust, without granting human-reviewed trust

#### Scenario: Human approval grants human-reviewed trust
- **WHEN** the developer approves the reviewed wiki content
- **THEN** the engine-owned `wiki.verify` effect adds the human verification event and leaves the concept `status: stable` with human-reviewed trust

### Requirement: Wiki review comments are applied by the wiki role
When the developer review gate returns comments, the workflow SHALL expose the bounded comments and any line or concept anchors to the next wiki documentation run. The wiki role SHALL read the named concepts, apply each valid comment without discarding unrelated content, and record which comments were resolved. A comment that is invalid or already satisfied SHALL be called out explicitly, and the wiki role SHALL not perform archival or human verification itself.

#### Scenario: Comments identify a concept edit
- **WHEN** a review comment names a concept and an anchored line
- **THEN** the next wiki run updates that concept and records the comment as resolved

#### Scenario: Invalid comment is reported
- **WHEN** a review comment cannot be applied to the current concept
- **THEN** the wiki run reports it as invalid or already satisfied instead of silently ignoring it

#### Scenario: Revision remains unverified
- **WHEN** the wiki role completes a comment-driven revision
- **THEN** touched concepts remain drafts without a human verification event until the developer approves again
