# Spec Delta

## ADDED Requirements

### Requirement: Multiplexer runtime selector

Application configuration SHALL accept one runtime-neutral multiplexer selector. The selector SHALL default to `herdr`, the `AGENTIC_CODING_MULTIPLEXER` environment variable SHALL override configured selection, and unsupported values SHALL fail validation with the supported identifiers. Resolution SHALL apply consistently to workflow execution, dashboard observation, and detached workflow subprocesses.

#### Scenario: Selector is absent

- **WHEN** neither configuration nor the environment selects a multiplexer
- **THEN** Herdr SHALL be selected
- **AND** existing configuration files SHALL remain valid without adding the field

#### Scenario: Configuration selects another runtime

- **WHEN** configuration selects a supported multiplexer and the environment override is unset
- **THEN** that runtime SHALL be selected for workflow execution and dashboard observation

#### Scenario: Environment overrides configuration

- **WHEN** the environment override selects a different runtime than configuration does
- **THEN** the environment override SHALL win
- **AND** the effective source SHALL be reportable in diagnostics

#### Scenario: Unsupported selector value

- **WHEN** configuration or the environment names an unsupported multiplexer
- **THEN** validation SHALL fail with a diagnostic naming the supported identifiers
- **AND** no workflow or dashboard operation SHALL run against a defaulted runtime

#### Scenario: Detached drain keeps the same runtime

- **WHEN** a detached workflow drain subprocess is spawned
- **THEN** the multiplexer selector and the selected runtime's connection variables SHALL be forwarded to that subprocess
- **AND** the child SHALL NOT resolve a different runtime than its parent
