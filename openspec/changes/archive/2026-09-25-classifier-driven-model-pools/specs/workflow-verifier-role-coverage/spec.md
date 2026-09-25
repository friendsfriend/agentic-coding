# Spec Delta

## MODIFIED Requirements

### Requirement: Single-sourced verifier role catalog

The verifier role catalog SHALL be exposed from the verification step module as the single source of truth, and the engine's selection validation and triage validation SHALL read that catalog instead of maintaining independent copies of the role names. The Settings preset editor SHALL route every verifier role through the one `core.verification` model pool and SHALL not maintain a per-role list of its own.

#### Scenario: Dashboard editor offers the catalog
- **WHEN** the dashboard preset editor renders the verification assignment fields
- **THEN** it SHALL offer the single `core.verification` pool
- **AND** it SHALL NOT list a per-role verification field or a role absent from the catalog

#### Scenario: Role set changes
- **WHEN** a verifier role is added to or removed from the catalog
- **THEN** engine selection validation and triage validation SHALL reflect the change without editing a second role-name list
- **AND** the single verification pool SHALL continue to cover every role

## ADDED Requirements

### Requirement: Grouped verification pool routing

All verifier roles selected for a round SHALL share the `core.verification` step's routing, resolved from the classifier-selected pool entry with the tagged default as fallback. The workflow SHALL NOT consult per-verifier-role profile assignments, and applying a `core.verification` selection SHALL replace every verifier-role route for the step.

#### Scenario: One selection covers every selected role
- **WHEN** triage selects two or more verifier roles and the classifier selects one `core.verification` pool entry
- **THEN** every selected verifier role SHALL launch with that entry's profile
- **AND** the read-only requirement SHALL still be enforced for each route

#### Scenario: No per-role assignment is consulted
- **WHEN** a stored preset defines a per-verifier-role assignment
- **THEN** configuration parsing SHALL reject it and point at Settings → Presets
- **AND** verification routing SHALL resolve only through the `core.verification` pool

#### Scenario: Verification round keeps its selected profile
- **WHEN** a verification round retries after a fix
- **THEN** every verifier role SHALL keep the profile pinned for the round unless a validated routing update changes it
