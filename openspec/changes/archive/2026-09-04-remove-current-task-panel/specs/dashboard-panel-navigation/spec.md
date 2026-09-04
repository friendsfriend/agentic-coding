## MODIFIED Requirements

### Requirement: Panel grid positions
The workflow dashboard detail view SHALL map its interactive panels onto a 2-column, 2-row grid: the Change panel SHALL occupy the top-left cell; the OpenSpec panel SHALL occupy the cell directly below Change and SHALL be present only while OpenSpec artifacts are listed; and the Agents panel SHALL occupy the right column spanning both rows. The detail view SHALL NOT include the Current task panel in the grid.

#### Scenario: Grid with artifacts listed
- **WHEN** the detail view renders with OpenSpec artifacts present
- **THEN** Change occupies the top-left cell, OpenSpec occupies the cell below Change, and Agents spans the right column beside both left cells

#### Scenario: Grid without artifacts
- **WHEN** the detail view renders with no OpenSpec artifacts
- **THEN** the OpenSpec cell is empty
- **AND** Change and Agents are the only focusable panels

### Requirement: Vim-style navigation with Shift modifier
The detail view SHALL move keyboard focus between panels using Shift+J (one cell down), Shift+K (one cell up), Shift+H (one cell left), and Shift+L (one cell right). When focus is at an edge of the grid in the pressed direction, focus SHALL wrap to the opposite edge. If a direction has no distinct rendered panel after skipping empty cells and the active panel's span, focus SHALL remain on the active panel.

#### Scenario: Vertical move down the left column
- **WHEN** focus is on the Change panel, OpenSpec artifacts are listed, and Shift+J is pressed
- **THEN** focus moves to the OpenSpec panel

#### Scenario: Vertical move up the left column
- **WHEN** focus is on the OpenSpec panel and Shift+K is pressed
- **THEN** focus moves to the Change panel

#### Scenario: Vertical wrapping in the left column
- **WHEN** focus is on Change or OpenSpec with OpenSpec artifacts listed and the user presses the corresponding upward or downward edge direction
- **THEN** focus wraps to the other panel in the left column

#### Scenario: Horizontal movement between columns
- **WHEN** focus is on Change, OpenSpec, or Agents and the user presses Shift+H or Shift+L toward the other column
- **THEN** focus moves between the left-column panel at that row and Agents

#### Scenario: No distinct vertical neighbor without OpenSpec artifacts
- **WHEN** focus is on Change or Agents, no OpenSpec artifacts are listed, and Shift+J or Shift+K is pressed
- **THEN** focus remains on the active panel

### Requirement: Navigation targets only rendered panels
Shift+J/K/H/L SHALL move focus only among panels that are currently rendered; a panel excluded from the grid SHALL be transparent to navigation rather than focused.

#### Scenario: OpenSpec excluded from the grid is skipped
- **WHEN** no OpenSpec artifacts are listed and focus is on Change or Agents
- **THEN** directional navigation SHALL NOT focus an OpenSpec or Current task panel

### Requirement: Existing panel interactions preserved
Unshifted `j`/`k` and `↑`/`↓` SHALL continue to scroll or move the selection inside the focused Change, OpenSpec, or Agents panel without changing focus, and `Tab` / `Shift+Tab` SHALL NOT move panel focus, staying reserved for the shell's tab bar.

#### Scenario: Unshifted scroll keys still work
- **WHEN** a panel is focused and unshifted `j`, `k`, `↑`, or `↓` is pressed
- **THEN** the focused panel scrolls or its selection moves as before
- **AND** focus does not change panels

#### Scenario: Tab does not move panel focus
- **WHEN** `Tab` or `Shift+Tab` is pressed in the detail view
- **THEN** panel focus remains unchanged
