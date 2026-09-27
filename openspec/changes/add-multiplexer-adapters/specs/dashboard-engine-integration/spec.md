# Spec Delta

## MODIFIED Requirements

### Requirement: Event-driven refresh
Dashboard SHALL refresh from canonical workflow events, outbox status, runtime observations, and telemetry updates rather than fixed phase assumptions.

#### Scenario: Refresh reacts to workflow output
- **WHEN** state revision or effect status changes
- **THEN** dashboard SHALL refresh validated workflow view
- **AND** it SHALL render current step/run state and available actions from view

#### Scenario: Runtime observation changes
- **WHEN** the selected multiplexer reports an agent status or telemetry change without a state revision
- **THEN** dashboard MAY refresh observation panels
- **AND** observation SHALL not be presented as committed step completion

#### Scenario: Runtime event stream is interrupted
- **WHEN** the selected multiplexer's event subscription drops or the runtime becomes temporarily unreachable
- **THEN** the dashboard SHALL resume or reconnect with bounded backoff without treating the gap as confirmed workflow state
- **AND** it SHALL NOT report a workflow change that no event or observation supports
