# Spec Delta: durable-agent-configuration

## Purpose

The compaction policy of durable runs is resolved from the canonical layered
configuration and read live at every resolution.

## MODIFIED Requirements

### Requirement: Durable agent settings section
The application configuration SHALL contain an `agentHost` section holding the default provider, default model, default thinking level, compaction, retry, steering mode and follow-up mode for durable runs. When the section is absent on first durable use, it SHALL be seeded once from the matching keys of the global pi `settings.json`; afterwards it SHALL NOT be overwritten from pi settings. The compaction policy SHALL additionally be resolvable from the `[agents.compaction]` section of the canonical layered configuration, which SHALL take effect for newly started runs and for running conversations, and a present `agentHost.compaction` SHALL take precedence over it. The resolution SHALL read the configuration again when it changes rather than fixing the policy when the host opens.

#### Scenario: First use seeds settings
- **WHEN** `agentHost` is absent and the global pi settings name a default provider and model
- **THEN** the first durable use SHALL write those values into `agentHost` and use them

#### Scenario: Owned after seeding
- **WHEN** `agentHost` exists and the user later changes the global pi default model
- **THEN** durable runs SHALL keep using the `agentHost` default model

#### Scenario: Compaction configured in the layered agents section
- **WHEN** `[agents.compaction]` sets a reserve and `agentHost.compaction` is absent
- **THEN** a durable run SHALL compact at that reserve

#### Scenario: Hand-written override wins
- **WHEN** both `agentHost.compaction` and `[agents.compaction]` are configured
- **THEN** the `agentHost` value SHALL be the effective one
