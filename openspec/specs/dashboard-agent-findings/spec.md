# dashboard-agent-findings Specification

## Purpose
TBD - created by archiving change extend-agent-panel-by-findings. Update Purpose after archive.
## Requirements
### Requirement: Current-round verifier finding counts in Agents panel

The workflow dash Agents panel SHALL display a compact count for each of `critical`, `warning`, and `info` findings on every verifier row that has a valid committed `core.findings` result for the current verification round. Counts SHALL include zero values so an empty result and a severity with no findings are represented explicitly. The counts SHALL be derived from the findings in that committed result, with each finding counted once according to its severity.

#### Scenario: Verifier has findings in multiple severities

- **WHEN** a verifier has a valid committed current-round result containing critical, warning, and info findings
- **THEN** its Agents-panel row SHALL show the corresponding count for each severity
- **AND** the displayed totals SHALL match the number of findings in the result for each severity

#### Scenario: Verifier result contains no findings

- **WHEN** a verifier has a valid committed current-round result whose findings array is empty
- **THEN** its Agents-panel row SHALL show zero for critical, warning, and info

#### Scenario: Verifier has no available committed result

- **WHEN** a verifier has no valid committed result for the current verification round
- **THEN** its Agents-panel row SHALL omit the finding-count summary rather than presenting unmeasured zero counts

### Requirement: Severity-specific finding colors

The Agents panel SHALL render the critical finding count in the dashboard's error/red semantic color, the warning finding count in the dashboard's warning/yellow semantic color, and the info finding count in the dashboard's info/blue semantic color. The severity labels and counts SHALL remain distinguishable from the agent's role, status, model, and telemetry metrics.

#### Scenario: Finding counts are rendered with severity colors

- **WHEN** a verifier row displays finding counts
- **THEN** critical text SHALL use the error semantic color
- **AND** warning text SHALL use the warning semantic color
- **AND** info text SHALL use the info semantic color

#### Scenario: Theme changes

- **WHEN** the dashboard uses a different configured theme
- **THEN** finding-count colors SHALL resolve through the theme-backed semantic color mappings
- **AND** the feature SHALL NOT rely on hard-coded terminal color values

### Requirement: Bounded non-disruptive finding summary

The finding-count summary SHALL fit within the existing Agents panel row width, SHALL not expand the dashboard grid or panel width, and SHALL preserve the existing agent metrics and verifier-result popup behavior. The summary SHALL be shown only for verifier findings and SHALL not be added to non-verifier agent rows.

#### Scenario: Narrow Agents panel

- **WHEN** the Agents panel is rendered at a narrow terminal width with large agent names or metric values
- **THEN** the finding-count summary SHALL remain within the panel bounds using the panel's existing overflow or scrolling behavior
- **AND** no adjacent dashboard panel SHALL be pushed or clipped by the summary

#### Scenario: Existing agent interactions remain available

- **WHEN** a user selects a verifier row with a finding summary
- **THEN** the existing `v` action SHALL still open that verifier's result
- **AND** existing metric values SHALL remain displayed according to the agent metrics behavior

#### Scenario: Non-verifier row

- **WHEN** the Agents panel renders a planner, worker, or other non-verifier agent
- **THEN** that row SHALL not display verifier finding counts

