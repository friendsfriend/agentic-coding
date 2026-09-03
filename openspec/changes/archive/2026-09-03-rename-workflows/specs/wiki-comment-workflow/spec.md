## ADDED Requirements

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
