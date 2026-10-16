## MODIFIED Requirements

### Requirement: Complete engine event export
Every durable current workflow event type the engine commits SHALL also be exported to telemetry, including the effect-exhaustion event written when a leased effect exceeds its maximum attempts. The engine SHALL NOT emit a legacy-import or semantic-migration event because those operations are not supported.

#### Scenario: Effect exhausts its attempts
- **WHEN** the engine fails a leased effect after its maximum attempts and writes the effect-exhaustion event
- **THEN** a corresponding telemetry event SHALL be exported with the effect kind, attempt count, error class, and the workflow attention count

#### Scenario: No legacy migration event is exported
- **WHEN** a current workflow store is opened or a current operator command runs
- **THEN** the engine SHALL NOT import a historical record or emit a legacy-migration event
