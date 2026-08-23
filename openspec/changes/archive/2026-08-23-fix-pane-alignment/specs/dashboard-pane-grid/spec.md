## Purpose

Defines that the workflow dashboard detail view arranges its panels on a consistent two-column grid so the vertical gutters between left- and right-column panes align across all dashboard rows.

## ADDED Requirements

### Requirement: Dashboard panes align on a uniform grid
The workflow dashboard detail view SHALL lay out its panel rows so that, at any terminal width, each row divides its usable width evenly between its two columns after accounting for the inter-column gutter, and every row's middle gutter SHALL occupy the same terminal column.

#### Scenario: Top-row gutter matches bottom-row gutters
- **WHEN** the workflow dashboard detail view is rendered with its top row (`Change`/`OpenSpec` column and `Agents` panel) and bottom rows (`Current task`/`Verification` and `Git status`/`Traces`)
- **THEN** the vertical gutter separating the top row's two columns SHALL be in the same terminal column as the gutters separating the panels of both bottom rows

#### Scenario: No horizontal overflow from fixed-width columns
- **WHEN** the workflow dashboard detail view is rendered at any terminal width
- **THEN** the total width requested by any single row's columns plus gutters SHALL NOT exceed the available content width
- **AND** no column shall be clipped or pushed beyond the right edge because another column used a fixed percentage width alongside a gap
