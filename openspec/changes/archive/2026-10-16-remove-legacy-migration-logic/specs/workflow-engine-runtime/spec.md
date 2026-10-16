## MODIFIED Requirements

### Requirement: Persisted state excludes terminal layout
Durable workflow snapshots SHALL contain workflow-meaningful state and run handles but SHALL NOT use pane/tab geometry or observed runtime status as lifecycle authority. The runtime SHALL decode the current persisted contract only and SHALL NOT import or translate historical snapshot shapes.

#### Scenario: Layout fields absent from saved state
- **WHEN** the engine persists a workflow
- **THEN** the snapshot SHALL omit transient verification pane order and spare-pane geometry
- **AND** current step completion SHALL derive only from committed commands, not pane state

#### Scenario: Runtime layout is reconstructed
- **WHEN** the dashboard or adapter needs terminal layout
- **THEN** it SHALL query live Herdr state or non-authoritative runtime records
- **AND** a missing pane SHALL not corrupt the workflow snapshot

### Requirement: Effect-native workflow application operations
Workflow initialization, start, dispatch, read projections, current-state repair previews, capability operations, and effect ownership operations SHALL expose Effect programs with typed expected failures and explicit concrete service requirements. Production and test dependencies SHALL be provided at application composition boundaries, not constructed within domain decisions.

#### Scenario: Caller composes startup and dispatch
- **WHEN** an application caller composes workflow operations
- **THEN** it SHALL compose Effect values without running nested runtimes inside engine services
- **AND** external execution SHALL occur only when an authorized composition boundary runs the program

#### Scenario: Test supplies dependencies
- **WHEN** a focused workflow test provides a temporary store, controlled clock, and fake external services
- **THEN** the same application program SHALL run without consulting hidden production dependencies

## ADDED Requirements

### Requirement: Workflow semantic migration command is absent
The workflow CLI and engine SHALL NOT expose `workflow migrate`, `operator.migrate`, or a semantic migration preview/effect. All other current workflow commands and current-state repair operations SHALL retain their existing behavior.

#### Scenario: Migration command is rejected
- **WHEN** a caller invokes `agentic-coding workflow migrate`
- **THEN** the CLI SHALL report an unsupported command
- **AND** it SHALL NOT preview or mutate workflow state
