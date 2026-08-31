## MODIFIED Requirements

### Requirement: Wiki approval gate precedes delivery
The system SHALL provide a developer-actor workflow step for wiki approval, positioned after the dedicated wiki documentation step. In every workflow definition that includes an archive step, the wiki documentation and approval steps SHALL precede the OpenSpec archive and delivery steps according to that definition's configured ordering. A definition without an archive step SHALL remain free of these steps unless it is explicitly the archive-free `wiki-only` workflow, whose purpose is documentation and whose approval advances directly to completion. The gate SHALL have the outcomes `approve` and `comments`. The approve outcome SHALL enqueue the engine-owned human-verification effect when the workflow has touched concepts and proceed to the definition's configured next step; the comments outcome SHALL return to the documentation step for `wiki-only` and for archive-before-approval definitions, or to the archive step for archive-after-approval definitions, under a bounded loop.

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

#### Scenario: Definitions without archive are unaffected
- **WHEN** a workflow definition has no archive step and is not explicitly `wiki-only`
- **THEN** it contains neither the wiki documentation step nor the wiki approval step

#### Scenario: Wiki-only approval completes directly
- **WHEN** the developer approves at the wiki approval gate for `wiki-only`
- **THEN** the engine promotes the touched concepts through its human-verification effect and advances directly to `core.completed`
- **AND** it SHALL not enqueue archive, delivery, or pull-request effects

#### Scenario: Wiki-only comments return to documentation
- **WHEN** the developer submits comments at the wiki approval gate for `wiki-only`
- **THEN** the workflow returns to `core.wiki` under its bounded review loop
