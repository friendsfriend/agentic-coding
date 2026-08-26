## Purpose

Provide a built-in model-agnostic workflow choice with a configurable harness, so installations run agents without shipping provider-specific model configuration.

## ADDED Requirements

### Requirement: Built-in use-default-model preset
The system SHALL expose `use-default-model` as the only built-in agent preset when no custom configuration is present. Its configuration SHALL select one supported harness (`pi`, `opencode`, or `opencode-v2`) and SHALL not configure a model. Selecting it, or starting with no custom routing configured, SHALL route agent work through the configured harness without a model so that harness selects its own default model.

#### Scenario: Workflow starts with the built-in preset
- **WHEN** a user starts a supported workflow with `use-default-model`
- **THEN** every agent launch SHALL use the configured harness without a model argument
- **AND** the workflow SHALL start without a user-defined profile

#### Scenario: Fresh configuration has no custom entries
- **WHEN** the agents configuration is absent or contains no custom profiles or presets
- **THEN** the dashboard SHALL offer `use-default-model` as the built-in preset
- **AND** a workflow start using the configuration defaults SHALL resolve to the same model-agnostic routing

#### Scenario: User configures the built-in preset harness
- **WHEN** a user sets the `use-default-model` preset harness in configuration to a supported runtime
- **THEN** subsequent workflow starts SHALL use that runtime without a model argument
- **AND** configuration parsing SHALL reject an unsupported harness before workflow start

### Requirement: Built-in preset is not managed custom configuration
The system SHALL keep `use-default-model` available independently of persisted custom profiles and routing. Dashboard management SHALL allow users to add, edit, and delete only custom entries and SHALL not persist a model-specific replacement for the built-in preset. Configuration SHALL permit the built-in preset's harness selection without creating a profile.

#### Scenario: User manages custom entries
- **WHEN** a user opens profile or preset management on a fresh configuration
- **THEN** no shipped model-specific profile or preset SHALL be listed as a custom entry
- **AND** the user SHALL be able to create custom profiles and presets on demand
