# Spec Delta

## MODIFIED Requirements

### Requirement: Panel grid positions
The workflow dashboard detail view SHALL map its interactive panels onto a 2-column, 3-row grid: the Change panel SHALL occupy the top-left cell; the OpenSpec panel SHALL occupy the cell directly below Change and SHALL be present only while OpenSpec artifacts are listed; the Classifier panel SHALL occupy the cell below OpenSpec and SHALL be present only while the workflow exposes classifier decisions; and the Agents panel SHALL occupy the right column spanning all three rows. The detail view SHALL NOT include the Current task panel in the grid.

#### Scenario: Grid with artifacts listed
- **WHEN** the detail view renders with OpenSpec artifacts present and no classifier decisions exposed
- **THEN** Change occupies the top-left cell, OpenSpec occupies the cell below Change, and Agents spans the right column beside both left cells

#### Scenario: Grid with artifacts and decisions listed
- **WHEN** the detail view renders with OpenSpec artifacts present and classifier decisions exposed
- **THEN** Change occupies the top-left cell, OpenSpec the cell below it, Classifier the cell below that, and Agents spans the right column beside all three left cells

#### Scenario: Grid without artifacts
- **WHEN** the detail view renders with no OpenSpec artifacts
- **THEN** the OpenSpec cell is empty
- **AND** Change, Classifier (when decisions are exposed), and Agents are the focusable panels

#### Scenario: Grid without decisions
- **WHEN** the detail view renders with no classifier decisions exposed
- **THEN** the Classifier cell is empty
- **AND** Change, OpenSpec (when artifacts are listed), and Agents are the focusable panels

### Requirement: Vim-style navigation with Shift modifier
The detail view SHALL move keyboard focus between panels using Shift+J (one cell down), Shift+K (one cell up), Shift+H (one cell left), and Shift+L (one cell right). When focus is at an edge of the grid in the pressed direction, focus SHALL wrap to the opposite edge. If a direction has no distinct rendered panel after skipping empty cells and the active panel's span, focus SHALL remain on the active panel.

#### Scenario: Vertical move down the left column
- **WHEN** focus is on the Change panel, OpenSpec artifacts are listed, and Shift+J is pressed
- **THEN** focus moves to the OpenSpec panel

#### Scenario: Vertical move up the left column
- **WHEN** focus is on the OpenSpec panel and Shift+K is pressed
- **THEN** focus moves to the Change panel

#### Scenario: Vertical move onto the classifier panel
- **WHEN** OpenSpec artifacts are listed, classifier decisions are exposed, and focus is on the OpenSpec panel with Shift+J pressed
- **THEN** focus moves to the Classifier panel

#### Scenario: Vertical wrapping in the left column
- **WHEN** focus is on the topmost or bottommost rendered left-column panel and the user presses the corresponding upward or downward edge direction
- **THEN** focus wraps to the other rendered left-column panel in that column

#### Scenario: Horizontal movement between columns
- **WHEN** focus is on Change, OpenSpec, Classifier, or Agents and the user presses Shift+H or Shift+L toward the other column
- **THEN** focus moves between the left-column panel at that row and Agents

#### Scenario: No distinct vertical neighbor without OpenSpec artifacts
- **WHEN** focus is on a rendered panel, no other panel is rendered in the pressed direction's scan, and Shift+J or Shift+K is pressed
- **THEN** focus remains on the active panel

### Requirement: Navigation targets only rendered panels
Shift+J/K/H/L SHALL move focus only among panels that are currently rendered; a panel excluded from the grid SHALL be transparent to navigation rather than focused.

#### Scenario: OpenSpec excluded from the grid is skipped
- **WHEN** no OpenSpec artifacts are listed and focus is on Change or Agents
- **THEN** directional navigation SHALL NOT focus an OpenSpec or Current task panel

#### Scenario: Classifier excluded from the grid is skipped
- **WHEN** no classifier decisions are exposed and focus is on Change or Agents
- **THEN** directional navigation SHALL NOT focus the Classifier panel

### Requirement: Existing panel interactions preserved
Unshifted `j`/`k` and `↑`/`↓` SHALL continue to scroll or move selection inside the focused Change, OpenSpec or Agents panel without changing focus. Tab/Shift+Tab SHALL traverse rendered local focus regions and SHALL NOT switch application destinations. Directional J/K/H/L navigation SHALL retain the existing grid rules.

#### Scenario: Unshifted scroll keys still work
- **WHEN** a panel is focused and unshifted `j`, `k`, `↑`, or `↓` is pressed
- **THEN** the focused panel scrolls or its selection moves as before
- **AND** focus does not change panels

#### Scenario: Tab traverses local focus
- **WHEN** Tab or Shift+Tab is pressed outside an input or overlay that owns it
- **THEN** focus SHALL move through valid local focus regions without switching application pages

### Requirement: Help documents panel navigation
The dashboard help modal SHALL list J/K/H/L under its navigation section and describe them as moving focus by direction.

#### Scenario: Help lists the directional bindings
- **WHEN** the dashboard help modal is open in the detail view
- **THEN** its navigation section SHALL contain entries for J, K, H, and L describing directional panel movement

#### Scenario: Help still describes in-panel scrolling
- **WHEN** the dashboard help modal is open in the detail view
- **THEN** its navigation section SHALL still describe `j`/`k` or `↑`/`↓` as scrolling the focused panel
