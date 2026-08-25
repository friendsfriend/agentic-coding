## MODIFIED Requirements

### Requirement: Dashboard panes align on a uniform grid
The workflow dashboard detail view SHALL lay out its panel rows so that, at any terminal width, each row divides its usable width evenly between its columns after accounting for the inter-column gutter, and every multi-column row's middle gutter SHALL occupy the same terminal column.

#### Scenario: Top-row gutter alignment
- **WHEN** the workflow dashboard detail view is rendered with its top row (`Change`/`OpenSpec` column and `Agents` panel)
- **THEN** the vertical gutter separating the top row's two columns SHALL be aligned consistently with any other multi-column row of the grid

#### Scenario: Full-width rows
- **WHEN** the workflow dashboard detail view renders a row containing a single panel (`Current task`, `Git status`)
- **THEN** that panel SHALL span the full usable content width without introducing a gutter

#### Scenario: No horizontal overflow from fixed-width columns
- **WHEN** the workflow dashboard detail view is rendered at any terminal width
- **THEN** the total width requested by any single row's columns plus gutters SHALL NOT exceed the available content width
- **AND** no column shall be clipped or pushed beyond the right edge because another column used a fixed percentage width alongside a gap
