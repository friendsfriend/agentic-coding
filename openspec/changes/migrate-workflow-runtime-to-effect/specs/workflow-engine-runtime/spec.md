## ADDED Requirements

### Requirement: Effect-native workflow application operations
Workflow initialization, start, dispatch, read projections, repair/migration previews, capability operations, and effect ownership operations SHALL expose Effect programs with typed expected failures and explicit concrete service requirements. Production and test dependencies SHALL be provided at application composition boundaries, not constructed within domain decisions.

#### Scenario: Caller composes startup and dispatch
- **WHEN** an application caller composes workflow operations
- **THEN** it SHALL compose Effect values without running nested runtimes inside engine services
- **AND** external execution SHALL occur only when an authorized composition boundary runs the program

#### Scenario: Test supplies dependencies
- **WHEN** a focused workflow test provides a temporary store, controlled clock, and fake external services
- **THEN** the same application program SHALL run without consulting hidden production dependencies

### Requirement: Pure workflow decisions remain independent of Effect execution
Definitions, registered step decisions, routing transforms, and read projections SHALL remain deterministic functions of supplied data. They SHALL not acquire Effect services, start fibers, perform I/O, or run an Effect runtime. Expected domain rejections SHALL be translated into the application error channel at an explicit boundary.

#### Scenario: Step completion is evaluated
- **WHEN** a registered step processes validated completion evidence
- **THEN** it SHALL return its pure decision without persistence or service access
- **AND** the engine SHALL retain final authorization and atomic application authority

### Requirement: Effect startup preserves shared configuration semantics
CLI and dashboard startup SHALL use the same Effect application preparation operation and decoded configuration services. Repository/worktree selection, repository-independent behavior, profile precedence, preflight checks, and non-secret execution setting pins SHALL retain their established semantics.

#### Scenario: Equivalent startup requests use different entry points
- **WHEN** CLI and dashboard prepare equivalent requests with the same service inputs
- **THEN** their routing, configuration provenance, and pinned delivery settings SHALL be equivalent apart from generated identities and timestamps
- **AND** neither application service SHALL import CLI or TUI presentation orchestration
