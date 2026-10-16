## MODIFIED Requirements

### Requirement: Definition pinning
Each workflow SHALL pin its exact workflow-definition identifier, version, and digest for its lifetime. Persisted v6 pins SHALL resolve only to their exact registered definition and executable step/behavior identities; the engine SHALL NOT reinterpret them or implicitly repin them. A new definition version tier SHALL be the default resolved version for new starts, and an already pinned v6 workflow SHALL keep resolving its own registered version. No semantic migration command or implicit migration path SHALL change a persisted pin.

#### Scenario: Workflow starts
- **WHEN** a start command accepts a workflow definition
- **THEN** the persisted workflow SHALL record its exact definition identity and enough semantic identity to resolve the accepted step implementations
- **AND** all later commands and effects SHALL evaluate against those implementations

#### Scenario: Registry definition changes
- **WHEN** a registered definition digest or required semantic compatibility identity no longer matches an active workflow pin
- **THEN** the workflow SHALL be blocked before further mutation or effect execution
- **AND** the engine SHALL require restoration of the exact implementation rather than reinterpret or migrate the pin

#### Scenario: New version tier becomes the start default
- **WHEN** a newer definition version tier is registered for a workflow family
- **THEN** new starts SHALL resolve that tier's definition
- **AND** a workflow already pinned to an earlier v6 tier SHALL keep resolving its own registered version without operator action

