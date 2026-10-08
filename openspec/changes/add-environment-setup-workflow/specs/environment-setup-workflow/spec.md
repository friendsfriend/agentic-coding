# Spec Delta

## Purpose

Agents author templated build/test/run and infrastructure definitions for an
app as drafts, validate them by running them, and publish them only after
developer approval.

## ADDED Requirements

### Requirement: Drafts only, repository read-only

The `env-setup` family SHALL write definitions only under its drafts directory; any change to the live configuration directory or to the repository checkout during authoring SHALL put the workflow in `attention-required`.

#### Scenario: Agent edits live config

- **WHEN** the author run modifies a file in the live `apps/compose` directory
- **THEN** the workflow SHALL enter `attention-required` and SHALL NOT promote

### Requirement: Drafts are runnable before approval

During authoring and validation, instances owned by the setup workflow SHALL resolve definitions from the drafts directory before the live configuration.

#### Scenario: Agent starts its draft

- **WHEN** the author run calls `env_start` for its app
- **THEN** the drafted compose target SHALL be used even though no live target exists

### Requirement: Deterministic validation gate

Before approval the workflow SHALL validate every drafted target with the template validator and by starting it to readiness; a failure SHALL return to authoring with the failure report, bounded to five rounds.

#### Scenario: Missing schema variable

- **WHEN** a drafted target requires isolated Postgres without `AC_DB_SCHEMA`
- **THEN** validation SHALL fail and the author SHALL receive the validator finding

### Requirement: Approval shows a diff and flags shared infra

The approval gate SHALL show every new and modified file as a diff against the live configuration and SHALL flag changes to existing shared infrastructure.

#### Scenario: Postgres definition changed

- **WHEN** drafts modify the existing `postgres` infra definition
- **THEN** the approval view SHALL mark it as affecting all apps

### Requirement: Atomic promotion with rollback

On approval the drafts SHALL be promoted with a protected backup of every replaced file and the catalog reloaded; any failure SHALL restore all replaced files and remove added ones.

#### Scenario: Write fails mid-promotion

- **WHEN** writing the third of five files fails
- **THEN** the live configuration SHALL be identical to its state before promotion
