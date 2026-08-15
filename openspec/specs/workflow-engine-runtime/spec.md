# workflow-engine-runtime Specification

## Purpose
TBD - created by archiving change consolidate-workflow-to-typescript. Update Purpose after archive.

## Requirements

### Requirement: TypeScript engine binary surface
The workflow engine SHALL be provided by `agentic-coding workflow` with mutation surface limited to `start`, `action`, `handoff`, and `repair`, read-only `status`, `projects`, and `config`, and separately named `agent-extension` management.

#### Scenario: Engine verb runs through the binary
- **WHEN** `agentic-coding workflow status --repo <repo> --change <id>` is run for existing workflow
- **THEN** it SHALL print validated workflow view with revision, pinned definition, current step, active runs, routing, health, and available actions
- **AND** it SHALL NOT expose raw mutable persisted snapshot as command contract

#### Scenario: Developer action executes
- **WHEN** caller runs `agentic-coding workflow action <action-id> --repo <repo> --change <id> --revision <revision>`
- **THEN** engine SHALL dispatch engine-provided action through unified command runtime
- **AND** unknown, unavailable, or stale action SHALL fail without mutation

#### Scenario: All verbs preserved
- **WHEN** caller inspects engine command surface
- **THEN** `start`, `status`, `action`, `handoff`, `repair`, `projects`, `config`, and `agent-extension` SHALL exist with specified contracts
- **AND** removed legacy role/phase verbs SHALL not exist
- **AND** handoff SHALL not accept agent-selected phase, role, change, or successor step

### Requirement: Engine module boundaries
The engine SHALL separate workflow definitions and reducers, transactional state runtime, external effect handlers, agent adapters, git/ssh, terminal layout, tracing/telemetry, and agent-extension management.

#### Scenario: Concerns are separated
- **WHEN** developer inspects engine source
- **THEN** pure definitions/reducers SHALL not invoke SQLite, filesystem, Git, Herdr, network, clock, or agent runtime
- **AND** agent adapters SHALL not select workflow successor or mutate workflow state directly
- **AND** no orchestration module SHALL bypass unified command runtime

### Requirement: Persisted state excludes terminal layout
Durable workflow snapshot SHALL contain workflow-meaningful state and run handles but SHALL NOT use pane/tab geometry or observed runtime status as lifecycle authority.

#### Scenario: Layout fields absent from saved state
- **WHEN** engine persists workflow
- **THEN** snapshot SHALL omit transient verification pane order and spare-pane geometry
- **AND** current step completion SHALL derive only from committed commands, not pane state

#### Scenario: Legacy state still loads
- **WHEN** recognized legacy state contains removed layout fields
- **THEN** migration SHALL ignore transient geometry while preserving validated workflow evidence
- **AND** resulting canonical snapshot SHALL omit those fields

#### Scenario: Runtime layout is reconstructed
- **WHEN** dashboard or adapter needs terminal layout
- **THEN** it SHALL query live Herdr state or non-authoritative runtime records
- **AND** missing pane SHALL not corrupt workflow snapshot
