## Purpose

Shows compact per-agent performance and cost metrics (cost, tokens in/out, cache hit rate, run duration, tokens/s) in the workflow dash Agents panel so users can compare agents at a glance.

## ADDED Requirements

### Requirement: Compact per-agent metric display
The dash Agents panel SHALL display, for each agent, its total cost, input tokens, output tokens, cache hit rate, run duration, and output tokens per second in a compact layout that fits within the agent's existing row area without expanding the panel's footprint beyond what the current two-line rows occupy plus at most one additional line.

#### Scenario: Agent with telemetry present
- **WHEN** the dashboard renders the Agents panel and the agent's role has recorded usage telemetry
- **THEN** the agent's row SHALL show cost, tokens in/out, cache hit rate, duration, and tokens/s values derived from that telemetry
- **AND** all metrics for one agent SHALL be visible without scrolling horizontally

#### Scenario: Comparing agents
- **WHEN** multiple agents are listed in the Agents panel
- **THEN** each agent's metrics SHALL be presented in a consistent order and format so values can be compared across agents

### Requirement: Metric derivation from telemetry
Per-agent metrics SHALL be aggregated from the workflow's telemetry events attributed to the agent's role: cost as the summed event cost, tokens as summed input/output token counts, cache hit rate as cached-read tokens divided by total input tokens, duration from the first to last lifecycle/usage event of the role, and tokens/s as output tokens divided by active generation time.

#### Scenario: Multiple usage events
- **WHEN** an agent's role has more than one usage event
- **THEN** cost and token counts SHALL be totals across all events
- **AND** duration SHALL span from the earliest to the latest event for the current run

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
