# custom-workflow-presentation Specification

## Purpose
TBD - created by archiving change show-custom-workflow-graph. Update Purpose after archive.
## Requirements
### Requirement: Custom definition origin and rationale are visible

The workflow view SHALL report whether the pinned definition is built-in or
custom, the stored origin of a custom definition, and the blueprint rationale
when one is pinned. The dashboard Change panel SHALL show a custom badge with the
origin and the rationale's first line, and the workspace sidebar SHALL mark rows
whose definition is custom.

#### Scenario: Orchestrator blueprint workflow

- **WHEN** the developer opens the dashboard of a workflow started from an
  orchestrator blueprint
- **THEN** the Change panel SHALL show the custom badge naming the orchestrator
  and the rationale's first line

#### Scenario: Built-in workflow

- **WHEN** the workflow runs a built-in definition
- **THEN** no custom badge or rationale SHALL be shown

### Requirement: Workflow graph dialog

The dashboard SHALL offer a workflow graph dialog from the Change panel that
lists the pinned definition's steps in walk order with their outcome edges,
highlights the current step, and distinguishes compiler-inserted routing and gate
steps from logical steps. The dialog's keybind SHALL be declared in the Change
panel's keybind catalog.

#### Scenario: Open the graph

- **WHEN** the developer presses the graph keybind on the Change panel
- **THEN** the dialog SHALL list every step with the current step highlighted

