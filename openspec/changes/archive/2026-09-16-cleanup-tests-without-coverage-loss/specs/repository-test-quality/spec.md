## ADDED Requirements

### Requirement: Cleanup preserves unique supported guarantees

Test cleanup SHALL preserve existing supported behavioral, security, persistence, ownership, compatibility, and externally observable contracts. Each removed test or assertion SHALL be accounted for by a surviving detector for its relevant inputs or an explicit explanation that it checks only incidental implementation detail or test-local scaffolding. Uncertain cases SHALL remain until reviewed; lower test counts alone SHALL NOT establish success.

#### Scenario: Overlapping behavioral check is removed
- **WHEN** cleanup removes a check as redundant
- **THEN** change-local verification evidence SHALL identify the surviving production-backed test and the guarantee it retains
- **AND** coverage of distinct failure paths SHALL NOT be replaced solely by a shared happy-path check

#### Scenario: Internal contract is still required
- **WHEN** an internal export, instruction, or migration check protects a still-supported documented requirement
- **THEN** cleanup SHALL retain that guarantee or an equivalent independent detector
- **AND** classifying the file as structural or historical SHALL NOT justify its removal

### Requirement: Historical digest expectations remain independent and complete

Deduplicated compatibility fixtures SHALL preserve every identity, version, definition digest, step association, step digest, and ordering previously asserted by the historical definition fixture. Expected values SHALL remain independent literals captured before cleanup, not values computed from the current implementation during a test run.

#### Scenario: Compact fixture replaces repeated expectations
- **WHEN** repeated digest maps are replaced by a shared literal representation
- **THEN** reconstructing the compact data SHALL equal the original complete expected data
- **AND** the runtime comparison SHALL retain the original guarded definition set

#### Scenario: Historical identity or step association drifts
- **WHEN** a guarded definition is missing or added, or a guarded digest or step association changes
- **THEN** the compatibility test SHALL fail rather than regenerate or omit the affected expectation

### Requirement: Behavioral assertions exercise the production path they name

Retained or repaired behavioral tests SHALL invoke production implementations and observe their outputs, callbacks, state, persistence, or rendered results. They SHALL NOT manufacture the asserted outcome or substitute a test-local implementation for the behavior they claim to validate. Test names and fixtures SHALL describe the actual scenario exercised.

#### Scenario: Location-picker acceptance stops working
- **WHEN** the production picker acceptance callback is disabled while rendering and filtering still work
- **THEN** the focused interaction test SHALL fail because actual input no longer produces the expected route

#### Scenario: Modal loses terminal-relative positioning
- **WHEN** production modal placement becomes relative to offset shell content instead of the terminal root
- **THEN** a test rendering the production modal in that context SHALL fail its positioning assertion

#### Scenario: Claimed boundary is absent from the fixture
- **WHEN** a test claims cycle or oversized-payload behavior
- **THEN** it SHALL exercise a genuine cycle or a payload exceeding the responsible boundary's limit respectively
- **AND** nullish-input checks SHALL be named and retained as nullish-input coverage rather than presented as size-limit coverage

### Requirement: Consolidated architecture checks detect prohibited edges

Architecture checks SHALL retain existing runtime-cycle, parent-barrel, layer, and environment-state ownership constraints. Environment ownership checks SHALL inspect resolved source dependencies through the existing TypeScript source-graph tooling rather than matching an incidental imported identifier. Allowed composition-root access SHALL remain allowed.

#### Scenario: Workflow imports environment state through a named binding
- **WHEN** a workflow module imports the environment state store through a normal named import
- **THEN** the ownership check SHALL fail and identify the offending source and dependency

#### Scenario: Prohibited dependency uses another supported import form
- **WHEN** a prohibited ownership edge is expressed as a re-export, type-only import, literal dynamic import, or literal require
- **THEN** the ownership check SHALL reject the resolved edge according to the same ownership policy

#### Scenario: Legitimate composition and parent-barrel guard survive consolidation
- **WHEN** duplicate architecture scans are consolidated
- **THEN** positive composition fixtures SHALL still pass
- **AND** a prohibited parent-barrel edge SHALL remain rejected independently of whether it forms a runtime cycle

### Requirement: Runtime smoke results distinguish skipped work and executed failure

Runtime smoke tests SHALL require explicit opt-in and SHALL report unselected or unavailable prerequisites as skipped, not passed. Once available prerequisites permit an attempted runtime operation, an unexpected execution or cleanup failure SHALL fail the check. Configured test reporting SHALL distinguish skipped cases from executed successes without silently claiming runtime coverage.

#### Scenario: Default suite runs without runtime opt-in
- **WHEN** no runtime smoke mode is selected
- **THEN** runtime smoke cases SHALL appear as skipped
- **AND** neither focused nor aggregate reporting SHALL count them as executed successful runtime checks

#### Scenario: Available runtime operation fails
- **WHEN** an opted-in smoke check has satisfied its prerequisites but its create, lifecycle, observation, or cleanup operation unexpectedly fails
- **THEN** the test SHALL report failure instead of printing a skip message and returning successfully

### Requirement: Resource preservation checks establish actual preservation safely

A runtime check claiming preservation of resources outside the operation's ownership SHALL compare meaningful identity and state before and after the exercised operation. Fixtures SHALL use uniquely identified test-owned resources, including separate-owner sentinels where needed, and SHALL NOT mutate unrelated user resources or provision runtimes automatically.

#### Scenario: Cleanup preserves a different owner's sentinel
- **WHEN** the tested cleanup operates on its own disposable resources while a separate-owner test sentinel exists
- **THEN** the test SHALL verify the sentinel remains with its expected identity and relevant state
- **AND** fixture teardown SHALL remove only resources created and owned by the test itself

### Requirement: Cleanup verification records bounded evidence

The cleanup SHALL record before/after suite results, removals and surviving detectors, and focused fault-probe results in change-local verification evidence. Fault probes SHALL run with a passing unmodified baseline, restore or discard mutated code afterward, and SHALL NOT be presented as exhaustive proof of defect coverage. Existing configured test surfaces SHALL remain discoverable and unexpected failures SHALL retain non-zero exits.

#### Scenario: Weak detector is replaced
- **WHEN** a cleanup replaces a detector shown to miss an injected production fault
- **THEN** verification SHALL demonstrate that the retained or repaired focused check fails for that fault and passes without it

#### Scenario: Verification encounters unrelated or intermittent failure
- **WHEN** a baseline or final run fails while focused reruns pass or concurrent changes are present
- **THEN** evidence SHALL record both outcomes and any unresolved cause
- **AND** cleanup SHALL NOT delete the affected contract test or relax its assertion merely to obtain a green run
