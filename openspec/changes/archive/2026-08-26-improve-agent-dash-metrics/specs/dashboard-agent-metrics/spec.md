## MODIFIED Requirements

### Requirement: Compact per-agent metric display
The dash Agents panel SHALL display, for each agent, its total cost, input tokens, output tokens, cache hit rate, run duration, and output tokens per second in a compact layout that fits within the agent's existing row area without expanding the panel's footprint beyond what the current two-line rows occupy plus at most one additional line. Cost SHALL be displayed exactly once in the agent row, in the compact metrics line; the verification status line SHALL NOT repeat the cost.

#### Scenario: Agent with telemetry present
- **WHEN** the dashboard renders the Agents panel and the agent's role has recorded usage telemetry
- **THEN** the agent's row SHALL show cost, tokens in/out, cache hit rate, duration, and tokens/s values derived from that telemetry
- **AND** the cost SHALL appear in the compact metrics line and not in the verification status text
- **AND** all metrics for one agent SHALL be visible without scrolling horizontally

#### Scenario: Comparing agents
- **WHEN** multiple agents are listed in the Agents panel
- **THEN** each agent's metrics SHALL be presented in a consistent order and format so values can be compared across agents
- **AND** each agent's cost SHALL have one display location in its row

### Requirement: Metric derivation from telemetry
Per-agent metrics SHALL be aggregated from the workflow's telemetry events attributed to the agent's role: cost as the summed event cost, tokens as summed input/output token counts, cache hit rate as cached-read tokens divided by the sum of cached-read and non-cached input tokens, duration from the first to last lifecycle/usage event of the role, and tokens/s as output tokens divided by active generation time. Cache-rate inputs SHALL be finite and non-negative; the rendered cache rate SHALL be omitted when either input component is unavailable or their sum is zero.

#### Scenario: Multiple usage events
- **WHEN** an agent's role has more than one usage event
- **THEN** cost and token counts SHALL be totals across all events
- **AND** cached-read and non-cached input tokens SHALL be totaled before calculating the cache-hit rate
- **AND** the resulting cache-hit rate SHALL be `cached-read / (cached-read + non-cached input)` as a percentage from 0% through 100%
- **AND** duration SHALL span from the earliest to the latest event for the current run

#### Scenario: Cache reads exceed non-cached input
- **WHEN** an agent has valid cached-read tokens that exceed its non-cached input tokens
- **THEN** the dashboard SHALL calculate the cache-hit rate using both components as the denominator
- **AND** the rendered percentage SHALL be no greater than 100%

#### Scenario: Missing or invalid cache telemetry
- **WHEN** an agent is missing either cache-read or non-cached input tokens, or either value is negative, non-finite, or produces a zero denominator
- **THEN** the panel SHALL omit the cache-hit rate rather than displaying a misleading percentage

#### Scenario: No usage telemetry yet
- **WHEN** an agent has no recorded usage events
- **THEN** the panel SHALL omit unavailable metrics rather than showing inferred or zero placeholders that could be mistaken for measured values
