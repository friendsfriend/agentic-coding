## MODIFIED Requirements

### Requirement: Target architecture — single `agentic-coding` binary
The catalog SHALL define one TypeScript `agentic-coding` binary providing transactional workflow engine and dashboard/observability views, with dashboard importing engine in-process and managed agents using runtime-neutral handoff command.

#### Scenario: Reader reviews target surface map
- **WHEN** developer opens target architecture
- **THEN** it SHALL enumerate engine `agentic-coding workflow`, per-workflow dashboard `agentic-coding dash`, workflow list `agentic-coding home`, and launcher `agentic-coding manager`
- **AND** dashboard SHALL import engine rather than spawn/reparse it

#### Scenario: Engine verbs enumerated
- **WHEN** developer reviews engine surface
- **THEN** catalog SHALL list `start`, `status`, `action`, `handoff`, `repair`, `projects`, `config`, and `agent-extension`
- **AND** it SHALL identify old phase/role verbs as intentionally removed

### Requirement: CLI compatibility constraint
The target architecture SHALL permit breaking legacy agent-facing workflow CLI so agents cannot select phase-specific transitions, while requiring all repository call sites to migrate atomically to generic handoff/action contracts.

#### Scenario: Migration keeps agents working
- **WHEN** new engine lands
- **THEN** prompts, instruction assets, dashboard, manager, scripts, README, and tests SHALL use new commands
- **AND** no compatibility shim SHALL translate removed role/phase verbs

#### Scenario: Agent interaction remains runtime-neutral
- **WHEN** Pi, OpenCode, or OpenCode V2 completes assignment
- **THEN** each SHALL use same generic handoff shape
- **AND** engine SHALL derive identity from run capability

### Requirement: Ranked migration backlog
The catalog SHALL reflect workflow-state redesign as replacement for earlier parity-focused consolidation constraints and SHALL keep remaining architecture findings independently actionable.

#### Scenario: Reader reviews the backlog table
- **WHEN** reader reviews consolidation target
- **THEN** R1 SHALL require single binary, in-process dashboard, unified command runtime, typed view, and runtime-neutral agent handoff
- **AND** it SHALL no longer require exact Python-era verb or raw state compatibility

#### Scenario: Each item is independently actionable
- **WHEN** later change selects remaining backlog item
- **THEN** catalog SHALL retain evidence and target invariant sufficient to implement independently
- **AND** no item SHALL require restoring removed legacy workflow compatibility

### Requirement: Contract-drift evidence (R1)
The catalog SHALL identify duplicated phase/state/action/role rules as evidence for registry-driven workflow view and command runtime.

#### Scenario: Phase-list divergence recorded
- **WHEN** developer reads R1 evidence
- **THEN** target invariant SHALL be one registered definition source for steps/transitions/actions, one validated state schema, and one typed dashboard view
- **AND** prompts/adapters SHALL not carry independent transition rules
