## ADDED Requirements

### Requirement: Catalog-driven verification role list in preset editor

The dashboard preset editor's verification-role assignments SHALL be derived from the workflow engine's registered verifier role catalog rather than from a dashboard-local list of role names.

#### Scenario: Editor renders the registered roles
- **WHEN** a user opens the stored-preset editor on the role-assignment field
- **THEN** the editor SHALL offer one entry per registered verification role, excluding no registered role
- **AND** it SHALL offer no entry for a role the engine does not register

#### Scenario: Registered role set changes
- **WHEN** the engine catalog gains or loses a verification role
- **THEN** the editor SHALL reflect the new set without a second role-name list being edited
- **AND** saved presets containing assignments for roles outside the current catalog SHALL still load and persist without being rewritten

#### Scenario: Assignment persists for a newly registered role
- **WHEN** a user assigns a profile to a verification role the editor obtained from the catalog and confirms the preset
- **THEN** the assignment SHALL be persisted under the preset's role table for the verification step
- **AND** the workflow SHALL resolve that profile for that role when the preset is used
