## MODIFIED Requirements

### Requirement: Wiki approval gate precedes delivery
The system SHALL provide a developer-actor workflow step for wiki approval, positioned after the dedicated wiki documentation step. In every code-changing workflow definition, the wiki documentation and approval steps SHALL run after developer review and SHALL precede the delivery step, and where the definition includes an OpenSpec archive step they SHALL be positioned relative to that archive step according to the definition's configured ordering. An archive-free code-changing workflow definition SHALL place the wiki documentation and approval steps between developer review and delivery. The archive-free documentation-only `wiki-only` workflow SHALL keep these steps with its approval advancing directly to completion. The gate SHALL have the outcomes `approve` and `comments`. The approve outcome SHALL enqueue the engine-owned human-verification effect when the workflow has touched concepts and proceed to the definition's configured next step; the comments outcome SHALL return to the documentation step for `wiki-only`, for archive-free code-changing definitions, and for archive-before-approval definitions, or to the archive step for archive-after-approval definitions, under a bounded loop.

#### Scenario: Documentation precedes review and archive
- **WHEN** an archive-bearing workflow is registered
- **THEN** its reachable path contains the wiki documentation step, wiki approval gate, archive step, and delivery step in the configured order

#### Scenario: Approval promotes before archive
- **WHEN** the developer approves at the wiki approval gate in an archive-bearing workflow
- **THEN** the engine promotes every touched concept through its human-verification effect and advances to the configured archive or delivery path

#### Scenario: Comments return to documentation before archive
- **WHEN** the developer submits comments at the wiki approval gate positioned before archive
- **THEN** the workflow returns to the dedicated wiki documentation step so the agent can revise the documentation

#### Scenario: Comments return to archive after archive
- **WHEN** the developer submits comments at the wiki approval gate positioned after archive
- **THEN** the workflow returns to the archive step so the archive agent can revise

#### Scenario: Archive-free code-changing workflow documents before delivery
- **WHEN** an archive-free code-changing workflow (such as `no-openspec`) is registered under a wiki-gated definition version
- **THEN** its reachable path contains the wiki documentation step and wiki approval gate between developer review and delivery, and it has no archive step
- **AND** approving the gate enqueues the human-verification effect for touched concepts and advances to delivery
- **AND** submitting comments at the gate returns the workflow to the dedicated wiki documentation step under a bounded loop

#### Scenario: Definitions without archive are unaffected
- **WHEN** an archive-free workflow definition changes no code (such as a proposal-only workflow) and is not explicitly `wiki-only` and not an archive-free code-changing workflow
- **THEN** it contains neither the wiki documentation step nor the wiki approval step

#### Scenario: Wiki-only approval completes directly
- **WHEN** the developer approves at the wiki approval gate for `wiki-only`
- **THEN** the engine promotes the touched concepts through its human-verification effect and advances directly to `core.completed`
- **AND** it SHALL not enqueue archive, delivery, or pull-request effects

#### Scenario: Wiki-only comments return to documentation
- **WHEN** the developer submits comments at the wiki approval gate for `wiki-only`
- **THEN** the workflow returns to `core.wiki` under its bounded review loop
