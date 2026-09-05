## ADDED Requirements

### Requirement: Source graph covers TypeScript and TSX
Architecture checks SHALL inspect source .ts and .tsx modules using the installed TypeScript parser, resolve project-relative static imports/re-exports and literal dynamic-import/require targets, and distinguish runtime edges from type-only dependencies.

#### Scenario: TSX closes a runtime cycle
- **WHEN** a value import through a .tsx module closes a source dependency cycle
- **THEN** the architecture test SHALL fail with the source dependency path

#### Scenario: Type-only references form a cycle
- **WHEN** a dependency cycle consists only of erased type references
- **THEN** it SHALL not be reported as an ESM runtime cycle
- **AND** independently forbidden architectural type dependencies SHALL still be checked

#### Scenario: Literal dynamic import crosses a boundary
- **WHEN** a literal import() or require() target crosses a forbidden layer boundary
- **THEN** the architecture check SHALL report the offending source and target instead of ignoring the edge

#### Scenario: Relative runtime target cannot resolve
- **WHEN** a source module refers to an unresolved project-relative runtime module
- **THEN** the check SHALL fail with an actionable source/specifier diagnostic

### Requirement: Application and presentation dependency direction
Runnable architecture tests SHALL enforce documented allowed edges between workflow core, application operations, CLI composition, adapters, and TUI. TUI SHALL not import workflow CLI command modules or barrels; workflow/backend modules SHALL not depend on TUI presentation; shared TUI primitives SHALL not depend on feature implementations. Existing parent-barrel and runtime-cycle guards SHALL remain enforced.

#### Scenario: Dashboard imports CLI orchestration
- **WHEN** a TUI module imports startup or command logic from the workflow CLI layer
- **THEN** the architecture check SHALL fail and identify the application-level boundary to use instead

#### Scenario: Core imports presentation types
- **WHEN** a workflow core module imports a TUI presentation module even only for types
- **THEN** the ownership check SHALL reject that dependency without treating it as a runtime cycle

#### Scenario: Shared primitive imports dashboard feature
- **WHEN** a shared modal or scroll primitive depends on dashboard or observability feature implementation
- **THEN** the check SHALL fail with that reversed dependency edge

### Requirement: Pure domain dependencies are guarded
Modules classified as pure definitions, contracts, or step behavior SHALL not depend directly or transitively on persistence, external effects, filesystem/process/network I/O, presentation, or ambient clocks. Tests SHALL also reject explicitly recognized direct I/O/clock globals and computed module loading in guarded pure modules. These checks SHALL be documented as bounded static guardrails rather than a security sandbox or whole-program purity proof.

#### Scenario: Pure step imports an I/O helper
- **WHEN** a step behavior imports a helper that transitively reads the filesystem or database
- **THEN** the check SHALL fail with the dependency path to the forbidden boundary

#### Scenario: Pure hook invokes a direct external API
- **WHEN** a guarded pure module directly invokes a recognized API such as Bun.spawnSync, fetch, or Date.now
- **THEN** the architecture test SHALL identify the source location and required explicit-data/effect boundary

#### Scenario: Pure behavior consumes supplied evidence and time
- **WHEN** a behavior uses typed validated evidence and an explicitly supplied timestamp without external access
- **THEN** the purity-boundary checks SHALL accept that module

### Requirement: Architecture exceptions remain explicit
Any necessary exception SHALL identify an exact dependency edge or source rule violation, a rationale, and a removal condition. Wildcard historical exemptions SHALL not be accepted, and unused exception entries SHALL fail validation.

#### Scenario: Known exception no longer exists
- **WHEN** a refactor removes an excepted dependency
- **THEN** the architecture check SHALL fail until the stale exception is removed

#### Scenario: New forbidden dependency appears beside an exception
- **WHEN** a module with one approved exception adds a different forbidden edge
- **THEN** the new edge SHALL fail independently of the existing exception
