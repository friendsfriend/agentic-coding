# stage-test-launch Specification

## Purpose
TBD - created by archiving change add-stage-test-launch. Update Purpose after archive.
## Requirements
### Requirement: Stage test starts from the independent-work form
The Wiki destination's independent-work creation form SHALL offer a **Stage test** workflow type with a stage picker, a multi-line ticket text field used as the task and an optional ticket reference. The picker SHALL list the allow-listed stages from the server's stage catalog with their environment and access marker; stages excluded by validation SHALL be shown as not selectable with their first diagnostic. Submitting SHALL start a `stage-test` workflow with the chosen stage, the ticket text as task and the reference as `ticket` metadata.

#### Scenario: Start from the dashboard
- **WHEN** the developer chooses Stage test, picks `grid-int`, pastes the ticket text and submits
- **THEN** a `stage-test` workflow SHALL start with metadata `stage: grid-int` and the pasted text as its task

#### Scenario: Excluded stage not selectable
- **WHEN** a stage file failed validation
- **THEN** the picker SHALL show it as not selectable together with its first diagnostic

#### Scenario: No stages configured
- **WHEN** the stage catalog is empty
- **THEN** the Stage test type SHALL explain that no stage is configured and SHALL NOT submit

### Requirement: Orchestrator starts stage tests with an established stage
The orchestrator's `start_workflow` SHALL accept `stage` for the `stage-test` workflow type and SHALL forward it to the server, which SHALL refuse an unknown stage with `stage-not-configured`. The orchestrator guidance SHALL require the developer to name the stage, or to confirm it when exactly one allow-listed stage exists for the named system, before starting.

#### Scenario: Unknown stage from the orchestrator
- **WHEN** the orchestrator calls `start_workflow` with workflow type `stage-test` and `stage: "nope"`
- **THEN** the tool result SHALL report `stage-not-configured` and no workflow SHALL start

### Requirement: Ticket reference seam
A stage-test start SHALL accept an optional ticket reference, store it as the workflow's `ticket` metadata and show it in the report header. Starting SHALL NOT contact any ticket system.

#### Scenario: Reference recorded
- **WHEN** a stage test starts with ticket reference `GRID-1234`
- **THEN** the workflow metadata SHALL carry `ticket: GRID-1234` and the report header SHALL name it

