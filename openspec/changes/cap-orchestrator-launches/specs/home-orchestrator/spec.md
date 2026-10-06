# Spec Delta

## ADDED Requirements

### Requirement: Orchestrator launch limits

The server SHALL refuse a workflow start from the orchestrator principal when the
number of orchestrator-started workflows that are neither `completed` nor
`closed`, across all workflow targets, has reached the configured `max_active`,
or when the number of orchestrator-started workflows created in the trailing 24
hours has reached `max_starts_per_day`. Defaults SHALL be 3 and 20. The refusal
SHALL use status 409 with code `orchestrator-limit` and SHALL name the limit, the
current count and the counted workflows. Starts from the operator principal SHALL
NOT be limited or counted.

#### Scenario: Active limit reached

- **WHEN** three orchestrator-started workflows are active and `max_active` is 3
- **AND** the orchestrator starts another workflow
- **THEN** the server SHALL answer 409 `orchestrator-limit` naming the three
  workflows
- **AND** no workflow SHALL be created

#### Scenario: Completed workflows free capacity

- **WHEN** one of those workflows completes
- **THEN** the next orchestrator start SHALL be accepted

#### Scenario: Developer start is unaffected

- **WHEN** the limit is reached and the developer starts a workflow
- **THEN** the start SHALL be accepted
