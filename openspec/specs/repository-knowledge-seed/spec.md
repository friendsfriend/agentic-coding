# repository-knowledge-seed Specification

## Purpose

Provide future planners with a concise, centralized, provenance-backed snapshot of repository architecture and operational constraints without changing application behavior.

## Requirements

### Requirement: Seed durable repository concepts

The system SHALL create or update the following shared-wiki concept identifiers from current repository evidence: `repository/architecture`, `repository/workflow-lifecycle`, `repository/agent-roles`, `repository/testing-and-validation`, `repository/configuration`, `repository/dashboard`, `repository/runtime-adapters`, and `repository/telemetry`.

#### Scenario: Seed covers the agreed planning surface

- **WHEN** repository knowledge initialization runs
- **THEN** each of the eight concept identifiers is present in the resolved shared wiki and contains concise concrete facts about its named planning concern

### Requirement: Seeds remain draft and traceable

Each seeded concept SHALL have non-empty `type`, `title`, and `description` frontmatter, SHALL have `status: draft`, SHALL include useful domain tags, and SHALL include at least one `sources` item with a non-empty `resource` naming a repository-relative evidence path. The concept body SHALL cite the relevant repository-relative paths and SHALL label inferred or version-sensitive claims.

#### Scenario: Draft provenance is recorded

- **WHEN** a seed concept is written
- **THEN** its returned document contains the required producer fields, draft status, source resources, and body citations, and does not claim human or machine verification

### Requirement: Existing knowledge is updated safely

Initialization SHALL search the shared wiki before selecting targets, update an exact existing concept identifier in place when present, and SHALL NOT create aliases or near-duplicate concepts. Updates SHALL preserve unrelated existing frontmatter and SHALL leave concepts outside the selected seed set unchanged.

#### Scenario: Existing concept is refreshed in place

- **WHEN** a selected identifier already exists before initialization
- **THEN** the same identifier is updated with current evidence and no second document or alias is created

#### Scenario: Unrelated concept is preserved

- **WHEN** a concept is outside the eight selected identifiers
- **THEN** initialization does not modify or delete it

### Requirement: Seed output is read back and validated

After writing, initialization SHALL read every created or updated seed through the wiki show operation and SHALL validate frontmatter conformance, source resources, draft status, claim-to-source alignment, and the absence of secrets, personal information, transient run state, generated digests, and speculative future design. The change's OpenSpec artifacts SHALL pass strict validation.

#### Scenario: All seeds pass focused review

- **WHEN** readback and strict validation complete
- **THEN** every selected concept has a conformant reviewed document and `openspec validate <change> --strict` succeeds

#### Scenario: Verification is deferred

- **WHEN** the seed is completed
- **THEN** no verification operation or verification event is added, and later archive or explicit human approval remains responsible for promotion
