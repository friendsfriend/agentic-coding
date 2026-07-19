# trace-tree-view Specification

## Based on: local-otel-trace-viewer

This spec extends the `local-otel-trace-viewer` requirements with a second implementation: a TypeScript/OpenTUI trace viewer that reads normalized trace JSONL and renders a tree-based trace browser using the opentui-starter baseline. The existing Go standalone receiver spec remains valid and unchanged.

## ADDED Requirements

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
