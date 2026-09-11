## MODIFIED Requirements

### Requirement: Target architecture — single `agentic-coding` binary
The catalog SHALL define one TypeScript `agentic-coding` executable with TUI and server modes, transactional workflow engine and environment/observability views. The dashboard SHALL consume a typed authenticated server API; the server SHALL invoke the workflow application in-process. Managed agents SHALL use the runtime-neutral handoff command with preserved capability checks. Unported environment services SHALL be explicitly private Go delegates during migration.

#### Scenario: Reader reviews target surface map
- **WHEN** a developer opens the target architecture
- **THEN** it SHALL enumerate default TUI, `server`, `attach`, `workflow`, `dash`, `home` and `manager` modes
- **AND** dashboard actions SHALL cross the typed API rather than spawn/reparse workflow commands or import execution internals

#### Scenario: Engine verbs enumerated
- **WHEN** a developer reviews the engine surface
- **THEN** the catalog SHALL list supported start/status/action/handoff/question/repair/projects/config/agent-extension/drain contracts
- **AND** it SHALL identify old phase/role verbs as intentionally removed

### Requirement: Ranked migration backlog
The catalog SHALL reflect the unified typed backend API as the current consolidation target while retaining independently actionable architecture findings and registered workflow semantics.

#### Scenario: Reader reviews the backlog table
- **WHEN** a reader reviews consolidation target
- **THEN** R1 SHALL require one executable, typed client/server boundary, unified server-side workflow command runtime, typed view and runtime-neutral agent handoff
- **AND** it SHALL NOT require direct dashboard engine imports or exact Python-era verb/raw state compatibility

#### Scenario: Each item is independently actionable
- **WHEN** a later change selects a remaining backlog item
- **THEN** the catalog SHALL retain evidence and target invariant sufficient to implement independently
- **AND** no item SHALL require restoring removed legacy workflow compatibility
