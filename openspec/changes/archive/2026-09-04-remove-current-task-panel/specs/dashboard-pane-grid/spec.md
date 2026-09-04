## MODIFIED Requirements

### Requirement: Dashboard panes align on a uniform grid
The workflow dashboard detail view SHALL lay out its interactive panels on a two-column grid so that, at any terminal width, the Change/OpenSpec column and Agents column divide usable width evenly after accounting for their inter-column gutter. The Change panel SHALL occupy the top-left cell; when OpenSpec artifacts are listed, the OpenSpec panel SHALL occupy the cell directly below it; and the Agents panel SHALL span the right column beside both left cells. Git status SHALL be rendered inside the primary Change/overview panel rather than in a separate panel. The detail view SHALL NOT render a Current task panel or a task-specific row.

#### Scenario: Two-column gutter alignment
- **WHEN** the workflow dashboard detail view is rendered with OpenSpec artifacts present
- **THEN** the vertical gutter between the Change/OpenSpec column and the Agents panel SHALL be aligned across the two rows

#### Scenario: Layout without OpenSpec artifacts
- **WHEN** the workflow dashboard detail view renders with no OpenSpec artifacts
- **THEN** the OpenSpec cell SHALL be empty
- **AND** the Change and Agents panels SHALL remain the only rendered detail panels

#### Scenario: Current task panel is absent
- **WHEN** the workflow dashboard detail view is rendered
- **THEN** it SHALL NOT render a Current task panel or a full-width task row

#### Scenario: Git status is part of the overview
- **WHEN** the workflow dashboard detail view is rendered
- **THEN** the primary Change/overview panel SHALL contain the Git status summary
- **AND** the detail view SHALL NOT render a separate Git status panel or row

#### Scenario: No horizontal overflow from fixed-width columns
- **WHEN** the workflow dashboard detail view is rendered at any terminal width
- **THEN** the total width requested by any row's columns plus gutters SHALL NOT exceed the available content width
- **AND** no column shall be clipped or pushed beyond the right edge because another column used a fixed percentage width alongside a gap
