# trace-tree-view Specification

## Purpose
TBD - created by archiving change otel-ui-improvements. Update Purpose after archive.
## Requirements
### Requirement: OpenTUI trace tree viewer application
The system SHALL provide an `otel-tui` TUI application built with OpenTUI/Solid that reads normalized trace JSONL files and renders a tree-based trace browser.

#### Scenario: Viewer renders trace list from JSONL file
- **WHEN** developer runs the viewer with a path to a valid trace JSONL file
- **THEN** viewer SHALL parse all lines and display a flat list of service root spans
- **AND** each row SHALL show: error indicator, service name, latency, received time, span name
- **AND** items SHALL be navigable with j/k keys

#### Scenario: Viewer renders trace tree on selection
- **WHEN** developer selects a service root span from the list
- **THEN** viewer SHALL display a tree of all spans in that trace, organised by parent/child hierarchy
- **AND** each tree node SHALL show: depth indent, expand/collapse indicator, span name, duration, status
- **AND** the tree SHALL be navigable with j/k (navigate), h (collapse), l (expand), Enter (select)

#### Scenario: Viewer shows span detail on tree node selection
- **WHEN** developer selects a span node in the tree
- **THEN** viewer SHALL display the selected span's attributes, resource attributes, scope info, status, and timing
- **AND** attributes SHALL be shown as sorted key-value list

#### Scenario: Viewer filters traces by text search
- **WHEN** developer presses `/` to focus the filter bar and enters text
- **THEN** viewer SHALL limit visible root spans to those matching span name, service name, or trace ID
- **AND** clearing the filter SHALL restore all root spans

#### Scenario: Viewer sorts traces by latency
- **WHEN** developer presses Ctrl+s in the trace list
- **THEN** viewer SHALL toggle sort between: received time (default), latency ascending, latency descending
- **AND** the list header SHALL indicate current sort column and direction

#### Scenario: Viewer tails JSONL file for live updates
- **WHEN** new lines are appended to the trace JSONL file
- **THEN** viewer SHALL ingest new spans within 200ms
- **AND** the trace list and any visible tree SHALL update without restart

#### Scenario: Viewer handles malformed JSONL lines
- **WHEN** a line in the JSONL file is not valid JSON or missing required span fields
- **THEN** viewer SHALL skip the malformed line
- **AND** viewer SHALL continue processing subsequent lines
- **AND** viewer SHALL remain running

#### Scenario: Viewer shows empty state when no traces loaded
- **WHEN** viewer starts with an empty JSONL file or no file argument
- **THEN** viewer SHALL display an empty state message
- **AND** viewer SHALL await new lines appended to the file

### Requirement: Keyboard-driven navigation
The viewer SHALL support keyboard navigation matching opentui-starter conventions, with context-sensitive keymaps and a help modal.

#### Scenario: Help modal shows keybinds
- **WHEN** developer presses `?`
- **THEN** viewer SHALL open a help modal listing available keybinds for the current focus context
- **AND** Escape SHALL close the help modal

#### Scenario: Focus switches between list and tree/detail
- **WHEN** developer presses `d` while trace list is focused
- **THEN** focus SHALL move to the detail panel (tree view or span detail)
- **WHEN** developer presses `t` while detail panel is focused
- **THEN** focus SHALL move back to the trace list

#### Scenario: Quit guard prevents accidental exit
- **WHEN** developer presses `q` once
- **THEN** viewer SHALL show a warning notification
- **WHEN** developer presses `q` again within 1 second
- **THEN** viewer SHALL exit

### Requirement: Data source abstraction
The viewer SHALL decouple trace data ingestion from view rendering via an interface, allowing alternative data sources (remote APIs, OTLP receivers) to be added without changing view code.

#### Scenario: TraceStore accepts any TraceSource
- **WHEN** a `TraceSource` implementation is passed to `TraceStore` constructor
- **THEN** all views (trace list, tree, detail) SHALL operate identically regardless of source type
- **AND** the file-based `JsonlFileSource` SHALL be the initial implementation shipped
- **AND** adding a new source SHALL NOT require changes to `views/` or `components/`

### Requirement: OpenTUI component conventions
The viewer SHALL use OpenTUI components and patterns from the opentui-starter baseline.

#### Scenario: Viewer uses opentui-starter layout
- **THEN** viewer SHALL have a header bar, a content area, and a status bar footer
- **AND** the status bar SHALL show context-sensitive keybind hints

#### Scenario: Viewer supports theme switching
- **WHEN** developer presses Shift+T
- **THEN** viewer SHALL open the theme picker modal (same as opentui-starter)
- **AND** theme changes SHALL apply immediately to the trace viewer

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

