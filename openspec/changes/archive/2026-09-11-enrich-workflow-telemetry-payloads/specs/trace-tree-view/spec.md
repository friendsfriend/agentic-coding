## ADDED Requirements

### Requirement: Every telemetry event renders in the viewer

The TUI SHALL render one span per telemetry event for every event name the engine, adapters, and runtime bridges can emit, including events it has no display label for, without dropping the event or failing the trace load. Each rendered span SHALL show its event name, its service (engine, runtime id, or layer), its duration when the event reports one, and its attributes.

#### Scenario: Event name has no display label

- **WHEN** the viewer loads a telemetry event whose name is not in the label catalog
- **THEN** the viewer SHALL display the raw event name
- **AND** the event SHALL remain selectable and SHALL keep its attributes and duration

#### Scenario: Unknown attribute keys are present

- **WHEN** an event carries attributes the viewer does not know
- **THEN** the span detail SHALL display those attributes as sorted key-value rows
- **AND** it SHALL NOT drop or merge them

#### Scenario: Event reports a duration and an error outcome

- **WHEN** an event reports a duration and an error outcome
- **THEN** the span SHALL span that duration and SHALL be marked as an error
- **AND** the error indicator SHALL appear in the trace list and the span tree

### Requirement: Numeric telemetry attributes stay queryable in the viewer

The viewer SHALL preserve the scalar type of telemetry attributes, SHALL display numeric attributes as numbers, and SHALL allow filtering traces by every telemetry attribute value, including the new engine, session, usage, cost, tool, and question attributes.

#### Scenario: Numeric attribute is displayed

- **WHEN** a span carries an integer or floating point attribute such as a token count, cost, attempt, or duration
- **THEN** the viewer SHALL display it as a number
- **AND** it SHALL NOT be rendered with a boolean or string representation

#### Scenario: Filter matches an attribute value

- **WHEN** the developer enters filter text that matches a telemetry attribute value, the event name, the workflow id, the role, or the runtime id
- **THEN** the viewer SHALL limit the visible traces to those matching
- **AND** clearing the filter SHALL restore all retained traces

#### Scenario: Boolean attribute is displayed

- **WHEN** a span carries a boolean telemetry attribute
- **THEN** the viewer SHALL display it as a boolean
- **AND** filter matching SHALL compare against its textual form

### Requirement: Telemetry spans group by workflow and session

The viewer SHALL group telemetry spans by workflow and SHALL make engine events and runtime events of the same run and runtime session navigable as one trace, using the workflow identity for grouping and the runtime session identity for correlation.

#### Scenario: Engine and runtime events share a workflow

- **WHEN** a trace contains engine events and runtime bridge events for the same workflow
- **THEN** the viewer SHALL group them into the same workflow trace

#### Scenario: Events of the same run and session are inspected

- **WHEN** the developer inspects a run whose engine and runtime events carry the same runtime session id
- **THEN** the viewer SHALL make the correlation visible in the span attributes
- **AND** it SHALL NOT require neighboring files or manual time correlation

#### Scenario: Telemetry file mixes layers and legacy records

- **WHEN** a telemetry file contains engine, adapter, runtime, and legacy events without a layer field
- **THEN** the viewer SHALL load all valid rows
- **AND** each span SHALL report the layer or runtime it could resolve, and a fallback service name otherwise
