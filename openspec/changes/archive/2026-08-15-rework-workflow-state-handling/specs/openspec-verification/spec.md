## MODIFIED Requirements

### Requirement: Verifier completion command contract
Every Herdr verifier run SHALL submit declared report through generic run-bound `agentic-coding workflow handoff --outcome complete --artifact "$HERDR_OUTPUT"`; verdict SHALL be derived by engine from validated findings schema.

#### Scenario: Verifier signals result with only supported flags
- **GIVEN** active verifier run has written declared output artifact matching assignment schema
- **WHEN** verifier invokes generic complete handoff
- **THEN** engine SHALL derive run, role, workflow, run generation, and output path authorization from environment capability
- **AND** engine SHALL validate findings and derive PASS/FAIL without verifier-provided verdict or role flag

#### Scenario: Unknown flag would stall verification
- **WHEN** handoff or report attempts to set role, change, phase, next step, successor, or verdict outside declared schema
- **THEN** engine SHALL reject handoff without consuming run capability
- **AND** workflow SHALL remain on current verification step

#### Scenario: Verifier skills share one identical completion command
- **WHEN** each dispatched verifier submits generic handoff
- **THEN** engine SHALL record each run exactly once
- **AND** verification reducer SHALL automatically start required test run or decide pass/fix after required set completes
- **AND** no verifier SHALL invoke separate coordination or finish-review command

#### Scenario: Verifier settles without handoff
- **WHEN** runtime becomes idle but valid handoff is absent
- **THEN** verifier run SHALL remain pending until handoff or configured timeout
- **AND** telemetry bridge SHALL not manufacture result
