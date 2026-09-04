# dashboard-openspec-panel Specification

## Purpose
TBD - created by archiving change remove-current-task-panel. Update Purpose after archive.
## Requirements
### Requirement: OpenSpec panel bounds visible artifact rows
The dashboard detail view SHALL render the OpenSpec panel when OpenSpec artifacts are available and SHALL show no more than five artifact rows at once. The panel SHALL retain every discovered artifact as a selectable item rather than truncating the artifact list.

#### Scenario: Five or fewer artifacts are available
- **WHEN** the detail view has between one and five OpenSpec artifacts
- **THEN** the OpenSpec panel SHALL show every artifact row

#### Scenario: More than five artifacts are available
- **WHEN** the detail view has more than five OpenSpec artifacts
- **THEN** the OpenSpec panel SHALL show exactly five artifact rows in its visible viewport
- **AND** artifacts beyond the fifth row SHALL remain available for selection

### Requirement: Focused OpenSpec panel supports artifact-list navigation
When the OpenSpec panel is focused, unshifted `j`/`k` and `↑`/`↓` SHALL move the artifact selection one row in the requested direction within the complete artifact list without changing panel focus. The list SHALL scroll to keep the selected artifact visible, and activating the selected artifact SHALL retain the existing formatted artifact view behavior.

#### Scenario: Navigate past the initial five visible artifacts
- **WHEN** the focused OpenSpec panel has more than five artifacts and the user presses `j` or `↓` from the last initially visible artifact
- **THEN** the next artifact SHALL become selected
- **AND** the list SHALL scroll so that selected artifact is visible
- **AND** focus SHALL remain on the OpenSpec panel

#### Scenario: Navigate upward in the artifact list
- **WHEN** the focused OpenSpec panel selection is below the first artifact and the user presses `k` or `↑`
- **THEN** the preceding artifact SHALL become selected
- **AND** the list SHALL scroll as needed to keep that selection visible

#### Scenario: Open the selected artifact
- **WHEN** the OpenSpec panel is focused and the user activates its selected artifact
- **THEN** the dashboard SHALL open that artifact using the formatted, scrollable OpenSpec artifact view

