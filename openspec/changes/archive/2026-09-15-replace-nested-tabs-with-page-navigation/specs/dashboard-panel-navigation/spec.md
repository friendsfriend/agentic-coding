## MODIFIED Requirements

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
