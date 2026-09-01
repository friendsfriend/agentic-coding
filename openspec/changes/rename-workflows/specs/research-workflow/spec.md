## ADDED Requirements

### Requirement: Research workflow catalog entry
The new-workflow modal SHALL expose the technical `research` workflow with the UI label `Research` and a description explaining its research, wiki, and wiki-review phases. The modal SHALL remove every parenthesized fragment from its labels, selectable values, and workflow display text while preserving optional read-only repository context and required task validation.

#### Scenario: Research choice displays its description
- **WHEN** a user opens the workflow-type step
- **THEN** the `Research` choice SHALL show its configured description as additional information
- **AND** the workflow-type step, its selectable values, and its workflow display text SHALL contain no parenthesized text

#### Scenario: Research selection preserves lifecycle
- **WHEN** a user selects `Research` and submits a non-empty task
- **THEN** startup SHALL continue to use the `research` definition and its existing research-to-wiki lifecycle
- **AND** standalone and repository-context semantics SHALL remain unchanged
