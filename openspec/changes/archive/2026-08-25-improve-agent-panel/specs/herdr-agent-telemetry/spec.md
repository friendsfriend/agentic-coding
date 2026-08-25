## ADDED Requirements

### Requirement: Usage telemetry carries efficiency metadata
Runtime usage telemetry SHALL include, alongside existing token and cost metadata, cache read token counts, message duration, and derived tokens-per-second whenever the runtime exposes them, and SHALL export these fields through the OTel log pipeline unchanged.

#### Scenario: Pi runtime reports usage with cache detail
- **WHEN** the pi runtime bridge receives a message-usage lifecycle that includes cache read tokens and timing
- **THEN** the emitted usage event SHALL contain input tokens, output tokens, cache read tokens, cost, duration, and tokens/s
- **AND** the same envelope SHALL reach both the local telemetry file and the configured OTLP endpoint

#### Scenario: Runtime lacks cache or timing detail
- **WHEN** a runtime bridge cannot observe cache token counts or message timing
- **THEN** it SHALL omit those fields from the usage event rather than emit zero-valued or inferred values

#### Scenario: Downstream consumers read new fields
- **WHEN** the workflow dash aggregates usage events for per-agent metrics
- **THEN** it SHALL read cache, duration, and tokens/s fields from the same usage events exported via OTel
- **AND** no parallel telemetry channel SHALL be required to populate the agents panel metrics
