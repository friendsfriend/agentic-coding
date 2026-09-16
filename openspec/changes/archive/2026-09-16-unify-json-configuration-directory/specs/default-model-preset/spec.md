## MODIFIED Requirements

### Requirement: Built-in use-default-model preset
The system SHALL expose `use-default-model` as the only built-in agent preset when the effective configuration has no custom configuration. The repository-provided `pi/herdr-workflow.json` SHALL contain only this model-agnostic agent default and portable application defaults; it SHALL NOT contain machine-specific profiles or custom presets. The built-in preset configuration SHALL select one supported harness (`pi`, `opencode`, or `opencode-v2`) and SHALL not configure a model. Selecting it, or starting with no custom routing configured, SHALL route agent work through the configured harness without a model so that the harness selects its own default model.

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
