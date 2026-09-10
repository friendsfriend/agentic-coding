# dashboard-agent-metrics Specification

## Purpose
Shows compact per-agent performance and cost metrics (cost, tokens in/out, cache hit rate, run duration, tokens/s) in the workflow dash Agents panel so users can compare agents at a glance.
## Requirements
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

Per-agent metrics SHALL be aggregated from the workflow's telemetry events attributed to the agent's role: cost as the summed event cost, tokens as summed input/output token counts, cache hit rate as cached-read tokens divided by the total prompt tokens (`cached-read + uncached input + cache-write`), duration as the sum of the role's active turns, and tokens/s as output tokens divided by active generation time. An active turn opens on `runtime.started`/`pi_agent_start`, closes on the next `runtime.settled`/`pi_agent_end`/`pi_agent_settled`, and a still-open turn closes at the role's last observed event; idle gaps between turns SHALL NOT count toward duration. When a role records no lifecycle boundary events, duration SHALL fall back to the wall-clock first→last event span. Cache-rate inputs SHALL be present, finite, and non-negative; the rendered cache rate SHALL be omitted when any cache-rate component is unavailable or the total prompt-token denominator is zero. A cache rate SHALL be rendered with one decimal place and SHALL distinguish any value below 100% from a full 100.0% hit rate.

#### Scenario: Multiple usage events

- **WHEN** an agent's role has more than one usage event
- **THEN** cost and token counts SHALL be totals across all events
- **AND** cached-read, uncached-input, and cache-write tokens SHALL be totaled before calculating the cache-hit rate
- **AND** the resulting cache-hit rate SHALL be `cached-read / (cached-read + uncached input + cache-write)` as a percentage from 0% through 100%, rendered to one decimal place
- **AND** duration SHALL sum the role's active turns, excluding idle gaps between them

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

### Requirement: Bounded rendering under narrow panels
The Agents panel SHALL keep metric text bounded (truncated with the panel's existing overflow behavior) so long model names or large token counts cannot break the dashboard grid layout.

#### Scenario: Very large token counts
- **WHEN** an agent's token counts exceed the space available in the metric row
- **THEN** the rendered text SHALL be truncated within the panel bounds instead of overflowing into adjacent panels

### Requirement: Demo parity
The dashboard demo/test dataset SHALL exercise every displayed metric so rendering of populated metric fields is covered by automated tests.

#### Scenario: Test dataset renders all metrics
- **WHEN** the dashboard is rendered against the demo dataset
- **THEN** each agent row SHALL include non-empty cost, tokens, cache hit rate, duration, and tokens/s values

