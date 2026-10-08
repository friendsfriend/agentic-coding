# Spec Delta

## ADDED Requirements

### Requirement: Server validates and starts blueprints

The unified server SHALL serve the blueprint step catalog and a validation route
that compiles a blueprint without any side effect and returns its compiled
summary, digest and diagnostics. The start route SHALL accept exactly one of a
built-in workflow type or a blueprint. For a blueprint it SHALL compile it, store
the resulting definition in the target store with its origin, pin the
blueprint's label, rationale and digest on the workflow, and start it; a
blueprint that fails compilation SHALL be refused before anything is written.

#### Scenario: Validate has no side effects

- **WHEN** a blueprint is validated
- **THEN** the response SHALL contain its digest or diagnostics
- **AND** no definition or workflow SHALL be stored

#### Scenario: Start with a blueprint

- **WHEN** a valid blueprint start is accepted
- **THEN** the workflow SHALL pin a `custom.` definition whose digest equals the
  validated digest
- **AND** its metadata SHALL carry the blueprint label and rationale

#### Scenario: Both type and blueprint

- **WHEN** a start request names both a workflow type and a blueprint
- **THEN** the server SHALL reject it as malformed
