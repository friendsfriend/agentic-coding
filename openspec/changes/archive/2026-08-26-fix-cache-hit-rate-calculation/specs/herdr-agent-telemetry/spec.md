## MODIFIED Requirements

### Requirement: Usage telemetry carries efficiency metadata

Runtime usage telemetry SHALL include, alongside existing token and cost metadata, cache read token counts, cache write token counts, message duration, and derived tokens-per-second whenever the runtime exposes them, and SHALL export these fields through the OTel log pipeline unchanged. An explicitly reported zero cache-write count SHALL be preserved; a field that the runtime does not expose SHALL remain omitted.

#### Scenario: Pi runtime reports usage with cache detail

- **WHEN** the pi runtime bridge receives a message-usage lifecycle that includes cache read and cache write tokens and timing
- **THEN** the emitted usage event SHALL contain input tokens, output tokens, cache read tokens, cache write tokens, cost, duration, and tokens/s
- **AND** the same envelope SHALL reach both the local telemetry file and the configured OTLP endpoint

#### Scenario: Pi runtime reports no cache writes

- **WHEN** the pi runtime reports a numeric cache-write count of zero
- **THEN** the emitted usage event SHALL contain `cacheWriteTokens: 0`
- **AND** downstream consumers SHALL be able to distinguish known zero cache writes from unavailable cache-write telemetry

#### Scenario: Runtime lacks cache or timing detail

- **WHEN** a runtime bridge cannot observe cache token counts or message timing
- **THEN** it SHALL omit those fields from the usage event rather than emit zero-valued or inferred values

#### Scenario: Downstream consumers read new fields

- **WHEN** the workflow dash aggregates usage events for per-agent metrics
- **THEN** it SHALL read cache-read and cache-write tokens, duration, and tokens/s fields from the same usage events exported via OTel
- **AND** it SHALL include both cache-read and cache-write tokens in the prompt-token denominator
- **AND** no parallel telemetry channel SHALL be required to populate the Agents panel metrics
