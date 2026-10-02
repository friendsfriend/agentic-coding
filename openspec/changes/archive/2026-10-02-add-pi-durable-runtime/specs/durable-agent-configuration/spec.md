## ADDED Requirements

### Requirement: Live global credentials
The durable host SHALL resolve provider credentials and custom model definitions from the user's global pi agent directory (`PI_CODING_AGENT_DIR` when set and non-blank, otherwise `~/.pi/agent`) at use time, through pi's credential runtime, and SHALL NOT copy credentials into agentic-coding configuration or workflow storage.

#### Scenario: User already logged in with pi
- **WHEN** the global pi `auth.json` holds a credential for the routed provider
- **THEN** a durable run SHALL authenticate with it without any additional configuration

#### Scenario: No credentials copied
- **WHEN** a durable run has completed
- **THEN** neither the agentic-coding configuration nor the workflow's host storage directory SHALL contain the credential values

### Requirement: Durable agent settings section
The application configuration SHALL contain an `agentHost` section holding the default provider, default model, default thinking level, compaction, retry, steering mode and follow-up mode for durable runs. When the section is absent on first durable use, it SHALL be seeded once from the matching keys of the global pi `settings.json`; afterwards it SHALL NOT be overwritten from pi settings.

#### Scenario: First use seeds settings
- **WHEN** `agentHost` is absent and the global pi settings name a default provider and model
- **THEN** the first durable use SHALL write those values into `agentHost` and use them

#### Scenario: Owned after seeding
- **WHEN** `agentHost` exists and the user later changes the global pi default model
- **THEN** durable runs SHALL keep using the `agentHost` default model

### Requirement: Model resolution for durable runs
A `pi-durable` profile model, with an optional `:<thinking>` suffix, SHALL select the run's model and thinking level; a route without a model SHALL use the `agentHost` defaults.

#### Scenario: Built-in preset without model
- **WHEN** a run routes through `use-default-model` to `pi-durable`
- **THEN** the run SHALL use the `agentHost` default model and thinking level
