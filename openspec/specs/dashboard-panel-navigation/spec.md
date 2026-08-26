# dashboard-panel-navigation Specification

## Purpose
Defines two-dimensional, vim-style panel navigation for the workflow dashboard detail view: Shift+J/K/H/L move focus between panels by grid position (rows and columns) with wrap-around at every edge, instead of cycling through a fixed one-dimensional order.

## Requirements

### Requirement: Panel grid positions
The workflow dashboard detail view SHALL map its interactive panels onto a 2-column grid: the Change panel SHALL occupy the top-left cell; the OpenSpec panel SHALL occupy the cell directly below Change and SHALL be present only while open-spec artifacts are listed; the Agents panel SHALL occupy the right column spanning the height of both left cells; the Current task panel SHALL occupy a full-width row below the two columns.

#### Scenario: Grid with artifacts listed
- **WHEN** the detail view renders with open-spec artifacts present
- **THEN** Change occupies the top-left cell, OpenSpec occupies the cell below Change, Agents spans the right column beside both of them, and Current task spans a full-width row at the bottom

#### Scenario: Grid without artifacts
- **WHEN** the detail view renders with no open-spec artifacts
- **THEN** the OpenSpec cell is empty and the left column consists of Change above Current task only

### Requirement: Vim-style navigation with Shift modifier
The detail view SHALL move keyboard focus between panels using Shift+J (one cell down), Shift+K (one cell up), Shift+H (one cell left), and Shift+L (one cell right). When focus is at an edge of the grid in the pressed direction, focus SHALL wrap to the opposite edge: bottom edge wraps to the top, top edge wraps to the bottom, left edge wraps to the right, and right edge wraps to the left.

#### Scenario: Vertical move down the left column
- **WHEN** focus is on the Change panel, artifacts are listed, and Shift+J is pressed
- **THEN** focus moves to the OpenSpec panel

#### Scenario: Vertical move up the left column
- **WHEN** focus is on the OpenSpec panel and Shift+K is pressed
- **THEN** focus moves to the Change panel

#### Scenario: Vertical move from the bottom row wraps to the top
- **WHEN** focus is on the Current task panel and Shift+J is pressed
- **THEN** focus moves to the Change panel (top of the column)

#### Scenario: Vertical move from the top row wraps to the bottom
- **WHEN** focus is on the Change panel and Shift+K is pressed
- **THEN** focus moves to the Current task panel (bottom of the column)

#### Scenario: Vertical move from a spanning panel
- **WHEN** focus is on the Agents panel and Shift+J or Shift+K is pressed
- **THEN** focus moves to the Current task panel (the only other panel in the right column)

#### Scenario: Horizontal move in the top row
- **WHEN** focus is on the Change panel and Shift+L is pressed
- **THEN** focus moves to the Agents panel

#### Scenario: Horizontal move wraps at the left edge
- **WHEN** focus is on the Change panel and Shift+H is pressed
- **THEN** focus wraps to the Agents panel (right edge of the row)

#### Scenario: Horizontal move from the left-bottom cell
- **WHEN** focus is on the OpenSpec panel and Shift+H or Shift+L is pressed
- **THEN** focus moves to the Agents panel

#### Scenario: No horizontal neighbor on the full-width row
- **WHEN** focus is on the Current task panel and Shift+H or Shift+L is pressed
- **THEN** focus remains on the Current task panel

### Requirement: Navigation targets only rendered panels
Shift+J/K/H/L SHALL move focus only among panels that are currently rendered; a panel excluded from the grid SHALL be transparent to navigation rather than focused.

#### Scenario: OpenSpec excluded from the grid is skipped
- **WHEN** no artifacts are listed, focus is on the Change panel, and Shift+J is pressed
- **THEN** focus moves directly to the Current task panel

#### Scenario: OpenSpec excluded from the grid is skipped upward
- **WHEN** no artifacts are listed, focus is on the Current task panel, and Shift+K is pressed
- **THEN** focus moves directly to the Change panel

### Requirement: Existing panel interactions preserved
Unshifted `j`/`k` and `↑`/`↓` SHALL continue to scroll or move the selection inside the focused panel without changing focus, and `Tab` / `Shift+Tab` SHALL NOT move panel focus, staying reserved for the shell's tab bar.

#### Scenario: Unshifted scroll keys still work
- **WHEN** a panel is focused and unshifted `j`, `k`, `↑`, or `↓` is pressed
- **THEN** the focused panel scrolls or its selection moves as before and focus does not change panels

#### Scenario: Tab does not move panel focus
- **WHEN** `Tab` or `Shift+Tab` is pressed in the detail view
- **THEN** panel focus remains unchanged (the keys stay available to the shell's tab bar)

### Requirement: Help documents panel navigation
The dashboard help modal SHALL list Shift+J/K/H/L under its navigation section and describe them as moving focus by direction.

#### Scenario: Help lists the directional bindings
- **WHEN** the dashboard help modal is open in the detail view
- **THEN** its navigation section SHALL contain entries for Shift+J, Shift+K, Shift+H, and Shift+L describing directional panel movement

#### Scenario: Help still describes in-panel scrolling
- **WHEN** the dashboard help modal is open in the detail view
- **THEN** its navigation section SHALL still describe `j`/`k` or `↑`/`↓` as scrolling the focused panel
