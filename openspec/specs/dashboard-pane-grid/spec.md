# dashboard-pane-grid Specification

## Purpose
Defines that the workflow dashboard detail view arranges its panels on a consistent two-column grid so the vertical gutters between left- and right-column panes align across all dashboard rows.
## Requirements
### Requirement: Dashboard panes align on a uniform grid
The workflow dashboard detail view SHALL lay out its interactive panels on a two-column grid so that, at any terminal width, the Change/OpenSpec/Classifier column and Agents column divide usable width evenly after accounting for their inter-column gutter. The Change panel SHALL occupy the top-left cell; when OpenSpec artifacts are listed, the OpenSpec panel SHALL occupy the cell directly below it; the Classifier panel SHALL occupy the cell below the OpenSpec cell, rendered for every workflow; and the Agents panel SHALL span the right column beside each of the first three left-column cells, with the Evidence panel occupying a full-width fourth row below them. Git status SHALL be rendered inside the primary Change/overview panel rather than in a separate panel. The detail view SHALL NOT render a Current task panel or a task-specific row.

#### Scenario: Two-column gutter alignment
- **WHEN** the workflow dashboard detail view is rendered with OpenSpec artifacts present
- **THEN** the vertical gutter between the Change/OpenSpec column and the Agents panel SHALL be aligned across the rendered rows

#### Scenario: Gutter alignment with classifier decisions
- **WHEN** the workflow dashboard detail view is rendered with OpenSpec artifacts and classifier decisions present
- **THEN** the vertical gutter between the left column and the Agents panel SHALL be aligned across all three rendered rows

#### Scenario: Evidence row alignment
- **WHEN** the workflow dashboard detail view is rendered with the Evidence panel present
- **THEN** the Evidence row SHALL span the full content width
- **AND** its outer edges SHALL line up with the left edge of the Change/OpenSpec/Classifier column and the right edge of the Agents panel

#### Scenario: Layout without OpenSpec artifacts
- **WHEN** the workflow dashboard detail view renders with no OpenSpec artifacts
- **THEN** the OpenSpec cell SHALL be empty
- **AND** the Change, Classifier, Agents and Evidence panels SHALL remain rendered detail panels

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

