## ADDED Requirements

### Requirement: Model availability preflight
At workflow start, the system SHALL validate that each routed profile's configured model is offered by the profile's execution environment, using the runtime CLI's model enumeration. Validation SHALL run during start-time routing preflight before any agent launches.

#### Scenario: Configured model is unavailable
- **WHEN** a routed profile names a model that the runtime's model enumeration does not include
- **THEN** workflow startup SHALL fail before any agent launches
- **AND** the error SHALL identify the profile, the runtime, the invalid model, and reference the available models

#### Scenario: Model with thinking suffix on pi
- **WHEN** a pi profile's model carries a `:<thinking>` suffix whose base id is available
- **THEN** the model SHALL pass availability validation

#### Scenario: Runtime model enumeration fails
- **WHEN** the runtime CLI cannot enumerate its models during preflight
- **THEN** workflow startup SHALL fail closed with the underlying command error rather than starting agents unvalidated
