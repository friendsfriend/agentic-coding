## MODIFIED Requirements

### Requirement: Telemetry spans group by workflow and session
The viewer SHALL group current-format telemetry spans by workflow and SHALL make current engine events and runtime events of the same run and runtime session navigable as one trace, using workflow identity for grouping and runtime session identity for correlation. It SHALL read the current telemetry source and SHALL NOT fall back to historical trace files or legacy event shapes.

#### Scenario: Engine and runtime events share a workflow
- **WHEN** a current-format trace contains engine events and runtime bridge events for the same workflow
- **THEN** the viewer SHALL group them into the same workflow trace

#### Scenario: Events of the same run and session are inspected
- **WHEN** the developer inspects a run whose current events carry the same runtime session id
- **THEN** the viewer SHALL make the correlation visible in the span attributes
- **AND** it SHALL NOT require neighboring files or manual time correlation

#### Scenario: Historical source is not loaded
- **WHEN** a workspace contains only `traces.jsonl` or legacy-only event records
- **THEN** the viewer SHALL not load them as current telemetry or rewrite the source
