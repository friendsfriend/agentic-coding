## MODIFIED Requirements

### Requirement: Metric derivation from telemetry

Per-agent metrics SHALL be aggregated from the workflow's telemetry events attributed to the agent's role: cost as the summed event cost, tokens as summed input/output token counts, cache hit rate as cached-read tokens divided by the total prompt tokens (`cached-read + uncached input + cache-write`), duration from the first to last lifecycle/usage event of the role, and tokens/s as output tokens divided by active generation time. Cache-rate inputs SHALL be present, finite, and non-negative; the rendered cache rate SHALL be omitted when any cache-rate component is unavailable or the total prompt-token denominator is zero. A cache rate SHALL be rendered with one decimal place and SHALL distinguish any value below 100% from a full 100.0% hit rate.

#### Scenario: Multiple usage events

- **WHEN** an agent's role has more than one usage event
- **THEN** cost and token counts SHALL be totals across all events
- **AND** cached-read, uncached-input, and cache-write tokens SHALL be totaled before calculating the cache-hit rate
- **AND** the resulting cache-hit rate SHALL be `cached-read / (cached-read + uncached input + cache-write)` as a percentage from 0% through 100%, rendered to one decimal place
- **AND** duration SHALL span from the earliest to the latest event for the current run

#### Scenario: Cache writes are present

- **WHEN** an agent has valid cached-read, uncached-input, and positive cache-write tokens
- **THEN** the dashboard SHALL include cache-write tokens in the prompt-token denominator
- **AND** the rendered cache-hit rate SHALL match pi's `cached-read / (input + cached-read + cache-write)` calculation

#### Scenario: Cache reads exceed non-cached input

- **WHEN** an agent has valid cached-read tokens that exceed its uncached input tokens
- **THEN** the dashboard SHALL calculate the cache-hit rate using cached-read, uncached-input, and cache-write tokens as the denominator
- **AND** the rendered percentage SHALL be no greater than 100%

#### Scenario: High but incomplete cache hit rate

- **WHEN** the calculated cache-hit rate is greater than 99% but less than 100%
- **THEN** the panel SHALL render the decimal rate below 100.0% rather than rounding it to 100%

#### Scenario: Missing or invalid cache telemetry

- **WHEN** an agent is missing any of cached-read, uncached-input, or cache-write tokens, or any value is negative or non-finite, or the total prompt-token denominator is zero
- **THEN** the panel SHALL omit the cache-hit rate rather than displaying a misleading percentage

#### Scenario: No usage telemetry yet

- **WHEN** an agent has no recorded usage events
- **THEN** the panel SHALL omit unavailable metrics rather than showing inferred or zero placeholders that could be mistaken for measured values
