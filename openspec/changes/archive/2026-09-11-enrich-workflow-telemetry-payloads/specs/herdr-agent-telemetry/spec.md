## MODIFIED Requirements

### Requirement: Runtime-neutral baseline telemetry
Every registered agent adapter SHALL emit normalized launch, assignment-delivered, observed-status, stop, error, and handoff events on the adapter telemetry layer even when no runtime plugin bridge is installed, each carrying the workflow, run, step, role, profile, runtime, effect, and runtime session identity when the adapter observes it, together with the outcome and duration of the observed lifecycle step.

#### Scenario: Any adapter launches run
- **WHEN** adapter begins and completes launch attempt
- **THEN** baseline events SHALL identify workflow, run, step, role, profile, runtime, effect, attempt, outcome, and duration
- **AND** the adapter SHALL emit one event for the launch attempt start and one for its outcome rather than a single unlabeled event

#### Scenario: Assignment is delivered to a live runtime
- **WHEN** an adapter delivers an assignment or a reused-prompt continuation to a live run
- **THEN** the adapter SHALL emit an assignment-delivered event carrying the run identity, the attempt, and the delivery duration

#### Scenario: Adapter observes stop or failure
- **WHEN** an adapter stops a run, or a launch, prompt, or stop operation fails
- **THEN** the adapter SHALL emit a stop or error event carrying the outcome, the duration, and a bounded error class
- **AND** no telemetry emission failure SHALL alter the workflow outcome

#### Scenario: Runtime bridge fails
- **WHEN** Pi extension or OpenCode plugin throws, is unavailable, or emits malformed data
- **THEN** workflow and agent SHALL continue unchanged
- **AND** baseline adapter telemetry SHALL remain authoritative only for observation, never lifecycle mutation

## ADDED Requirements

### Requirement: Self-describing telemetry events

Every exported telemetry event SHALL identify its layer, runtime when runtime-scoped, workflow, step, and, when the event is attributable to one, its run, role, profile, and effect, so that a single event row can be attributed and joined without reading neighboring rows. An event that cannot resolve an identity field SHALL omit it rather than emit a placeholder.

#### Scenario: Event is exported without bridge participation

- **WHEN** the engine or an adapter exports an event while no runtime bridge is installed
- **THEN** the event SHALL still carry its layer, workflow, and step identity
- **AND** it SHALL carry role, profile, and runtime identity when the event is attributable to a run

#### Scenario: Event identity cannot be resolved

- **WHEN** an event cannot be attributed to a run, effect, or runtime session
- **THEN** the corresponding identity fields SHALL be absent
- **AND** the event SHALL remain exported

#### Scenario: Runtime events are joined to engine events

- **WHEN** a runtime bridge event and an engine event refer to the same run and runtime session
- **THEN** both events SHALL carry the same run id and runtime session id
- **AND** a consumer SHALL be able to join them on those fields alone
