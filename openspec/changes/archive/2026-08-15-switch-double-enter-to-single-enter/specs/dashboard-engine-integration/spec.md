## MODIFIED Requirements

### Requirement: Engine-provided workflow view
Dashboard SHALL consume one typed workflow view containing revision, pinned definition, current step, active runs, resolved runtime/profile per run, validation/attention state, and available actions.

#### Scenario: Workflow uses additional registered step
- **WHEN** dashboard loads definition containing step not hardcoded in UI
- **THEN** it SHALL render registry-provided label/status/action metadata
- **AND** no UI phase list change SHALL be required for basic operation

#### Scenario: Repair UI opens
- **WHEN** developer requests repair
- **THEN** dashboard SHALL request compatible targets from engine
- **AND** repair modal SHALL show revision, target, reason requirement, and affected runs before dispatch
- **AND** a single Enter with non-empty reason SHALL dispatch repair with current revision
