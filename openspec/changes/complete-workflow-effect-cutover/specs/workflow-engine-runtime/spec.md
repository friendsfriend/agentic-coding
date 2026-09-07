## ADDED Requirements

### Requirement: Workflow application runtimes have explicit lifecycle owners
CLI commands and dashboard integration SHALL execute workflow Effect programs through named application composition roots. CLI invocation SHALL own its bounded runtime lifetime; dashboard SHALL reuse one application runtime with owned repository scopes. Internal services SHALL not execute nested runtimes or instantiate alternative production orchestration paths.

#### Scenario: Dashboard refresh repeats
- **WHEN** the dashboard refreshes a workflow repeatedly
- **THEN** it SHALL reuse its application runtime and existing execution ownership rather than create new runtimes or drainers per read

#### Scenario: Application shuts down
- **WHEN** CLI or dashboard receives controlled shutdown
- **THEN** it SHALL interrupt owned temporary work and finalize/export within documented bounds
- **AND** it SHALL not stop durable agents/workspaces merely because their creating execution scope ended

### Requirement: Effect integration preserves explicit execution and external contracts
Final Effect callers SHALL retain established CLI/JSON behavior, read-only observation, explicit drain/continuation scheduling, revision-bound actions, and durable recovery. Runtime cancellation or telemetry failure SHALL not automatically replay a committed mutation. Workflow telemetry SHALL preserve existing envelope and trace correlation with bounded redacted export.

#### Scenario: CLI exits after a command commits
- **WHEN** a committed command leaves pending work and its initiating CLI exits
- **THEN** explicit continuation or later startup/resume SHALL recover that work without requiring a status read to execute effects

#### Scenario: Telemetry export fails
- **WHEN** export fails after command commit
- **THEN** the committed workflow result SHALL remain authoritative and SHALL not be rolled back or replayed
- **AND** export cleanup SHALL not keep application shutdown alive beyond its budget

### Requirement: Full workflow migration has no legacy orchestration path
Every inventoried workflow application/I/O caller SHALL use the Effect application model at completion. Pure functions, named native/foreign API adapters, and outer framework bridges SHALL remain explicit valid boundaries. Migration-only facades and replaced implementations SHALL be removed. Existing source architecture checks SHALL guard runtime owners, native boundaries, obsolete imports, and application/presentation dependency direction.

#### Scenario: Legacy caller remains at cutover
- **WHEN** the final inventory or architecture check finds a caller using a migration-only engine or handler facade
- **THEN** cutover verification SHALL fail and identify the caller and required application boundary

#### Scenario: Service runs a nested runtime
- **WHEN** a guarded workflow service invokes a recognized runtime execution API outside an allowed composition root
- **THEN** the architecture check SHALL fail with the offending source location

#### Scenario: Pure helper remains plain TypeScript
- **WHEN** a deterministic helper uses supplied values without I/O, service acquisition, or runtime execution
- **THEN** migration coverage SHALL accept it as a documented pure boundary rather than require an Effect wrapper
