## ADDED Requirements

### Requirement: Agent runtime metadata reaches the dashboard projection

The dashboard agent data projection SHALL preserve the runtime from the latest workflow run associated with each displayed agent role, without resolving or inferring the runtime from the executable or model. The runtime field MAY be absent for legacy or synthetic data that has no associated run.

#### Scenario: Displayed agent has a pinned runtime

- **WHEN** a workflow view contains a run for a displayed agent role with runtime `pi`, `opencode`, or `opencode-v2`
- **THEN** the corresponding dashboard agent data SHALL contain that run's runtime

#### Scenario: Agent data has no run runtime

- **WHEN** a displayed agent has no associated run runtime
- **THEN** the dashboard projection SHALL leave runtime unavailable rather than inventing a runtime value

### Requirement: Agents panel displays runtime beside selected model

The workflow dashboard Agents panel SHALL display an agent's runtime and selected model together on the existing model line. When both values are available, the runtime SHALL precede the model separated by ` · `. When only one value is available, the panel SHALL display that value. When neither is available, the panel SHALL preserve the existing role-specific fallback text.

#### Scenario: Pi agent with selected model

- **WHEN** an agent row has runtime `pi` and selected model `provider/model`
- **THEN** the existing model line SHALL display `pi · provider/model`

#### Scenario: Stable OpenCode agent with selected model

- **WHEN** an agent row has runtime `opencode` and selected model `provider/model`
- **THEN** the existing model line SHALL display `opencode · provider/model`

#### Scenario: OpenCode V2 agent with selected model

- **WHEN** an agent row has internal runtime `opencode-v2` and selected model `provider/model`
- **THEN** the existing model line SHALL display `opencode2 · provider/model`
- **AND** the model line SHALL NOT display `opencode-v2`

#### Scenario: Runtime without selected model

- **WHEN** an agent row has a runtime but no selected model
- **THEN** the model line SHALL display the normalized runtime without a fabricated model name

#### Scenario: Selected model without runtime

- **WHEN** an agent row has a selected model but no runtime
- **THEN** the model line SHALL display the selected model as it does today

### Requirement: Runtime and model rendering remains bounded

The runtime/model text SHALL remain within the existing Agents panel row bounds and SHALL use the panel's existing overflow behavior. Adding runtime SHALL not add an agent-row line or expand the Agents panel footprint.

#### Scenario: Long runtime and model value

- **WHEN** the combined runtime and model text is wider than the available model-line width
- **THEN** the text SHALL be clipped by the existing row container without overflowing into adjacent panels
- **AND** the agent row SHALL retain its existing line count
