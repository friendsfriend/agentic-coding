# Spec Delta

## Purpose

One-time, reversible conversion of singleton environment definitions into
templated ones, plus a validator that keeps them templated.

## ADDED Requirements

### Requirement: Template migration is previewed and reversible

`agentic-coding env migrate-templates` SHALL print the planned edits without writing by default; with `--apply` it SHALL write a protected backup of every modified file before changing it, and `--restore` SHALL restore a backup. Apply SHALL be refused while an agent-owned instance is running.

#### Scenario: Dry run

- **WHEN** the command runs without `--apply`
- **THEN** no file SHALL be modified and every planned edit SHALL be listed per file

#### Scenario: Re-run after apply

- **WHEN** the command runs again on an already converted tree
- **THEN** it SHALL report zero edits

### Requirement: Mechanical compose rewrite

The migration SHALL remove `container_name` from app services, template published host ports as `AC_PORT_<NAME>` with the original port as default, template the app image tag with `AC_IMAGE_TAG` defaulting to `latest`, replace infra `include:` entries with requires metadata and declare `devenv-local` external, preserving comments and key order. A file with an unrecognized shape SHALL be reported and left unchanged.

#### Scenario: Converted file still runs for the user

- **WHEN** the user starts a converted target as the `user` instance
- **THEN** it SHALL publish the same host ports and use the same image as before conversion

### Requirement: Template validator

`agentic-coding env validate` SHALL classify every run target as templated, untemplated (with reasons) or needs-semantic-pass (requires an isolated infra without referencing `AC_DB_SCHEMA`, or no OTel variables).

#### Scenario: Missing schema variable

- **WHEN** a templated target requires isolated Postgres but never references `AC_DB_SCHEMA`
- **THEN** the validator SHALL report it as needs-semantic-pass naming `AC_DB_SCHEMA`
