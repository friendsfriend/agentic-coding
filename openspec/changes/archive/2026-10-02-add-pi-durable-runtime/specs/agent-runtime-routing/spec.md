## MODIFIED Requirements

### Requirement: Pi, OpenCode, and OpenCode V2 adapters
The system SHALL provide adapters for the bundled durable runtime `pi-durable`, Pi, stable OpenCode `opencode`, and official OpenCode V2 beta `opencode2`, all using the common assignment/handoff protocol. Pi, OpenCode and OpenCode V2 SHALL use the selected multiplexer's managed agent lifecycle. `pi-durable` SHALL run in the workflow's bundled durable host without allocating a multiplexer pane.

#### Scenario: Pi durable run launches
- **WHEN** run routes to a `pi-durable` profile
- **THEN** engine SHALL ensure the workflow's durable host is running, create or reuse the run's conversation, and submit the rendered assignment with an idempotent request id
- **AND** no multiplexer pane SHALL be created for the run

#### Scenario: Pi durable run observed after host crash
- **WHEN** the engine observes a `pi-durable` run whose host is not running
- **THEN** the adapter SHALL restart the host over the existing storage so the run resumes before reporting status

#### Scenario: Pi run launches
- **WHEN** run routes to Pi profile and Pi is installed
- **THEN** engine SHALL launch Pi through the selected multiplexer's agent lifecycle
- **AND** send rendered assignment message through detected agent

#### Scenario: OpenCode run launches
- **WHEN** run routes to stable OpenCode profile and `opencode` is installed
- **THEN** engine SHALL launch the OpenCode agent through the selected multiplexer's lifecycle with profile model/options
- **AND** use same rendered assignment and handoff contracts as Pi

#### Scenario: OpenCode V2 run launches
- **WHEN** run routes to OpenCode V2 profile and official `opencode2` is installed
- **THEN** engine SHALL launch detected OpenCode V2 process through the selected multiplexer's managed OpenCode lifecycle using isolated executable resolution
- **AND** use same rendered assignment and handoff contracts as other adapters

#### Scenario: Configured executable is missing
- **WHEN** selected Pi, OpenCode, or OpenCode V2 executable is absent
- **THEN** preflight SHALL fail with runtime/profile diagnostic before state advances or pane is created
- **AND** engine SHALL NOT install executable automatically

#### Scenario: Selected multiplexer is unavailable
- **WHEN** the selected multiplexer runtime cannot be reached while routing a Pi, OpenCode, or OpenCode V2 agent step
- **THEN** the launch SHALL fail with a diagnostic naming the selected runtime
- **AND** the engine SHALL NOT launch the agent through another multiplexer

### Requirement: Model availability preflight
At workflow start, the system SHALL validate that each routed profile's configured model is offered by the profile's execution environment, using the runtime CLI's model enumeration, or for `pi-durable` the bundled model runtime's enumeration of available models. Validation SHALL run during start-time routing preflight before any agent launches.

#### Scenario: Configured model is unavailable
- **WHEN** a routed profile names a model that the runtime's model enumeration does not include
- **THEN** workflow startup SHALL fail before any agent launches
- **AND** the error SHALL identify the profile, the runtime, the invalid model, and reference the available models

#### Scenario: Model with thinking suffix on pi
- **WHEN** a pi or `pi-durable` profile's model carries a `:<thinking>` suffix whose base id is available
- **THEN** the model SHALL pass availability validation

#### Scenario: Durable model enumeration
- **WHEN** a `pi-durable` profile names a model available through the user's global pi credentials
- **THEN** preflight SHALL pass without invoking any external executable

#### Scenario: Runtime model enumeration fails
- **WHEN** the runtime CLI or bundled model runtime cannot enumerate its models during preflight
- **THEN** workflow startup SHALL fail closed with the underlying error rather than starting agents unvalidated
