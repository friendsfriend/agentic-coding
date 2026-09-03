# workflow-duration-formatting Specification

## Purpose
Humanized formatting of run durations in the workflow dashboard, backed by a pure, unit-tested helper.

## Requirements

### Requirement: Humanized run duration formatting
The workflow dashboard SHALL render available run durations as compact humanized strings produced by a pure `formatDuration` helper, instead of raw second counts.

#### Scenario: Short run duration under one minute
- **WHEN** a run duration is defined and is less than 60 seconds
- **THEN** the dashboard label shows the whole seconds value followed by `s` (e.g. `0s`, `3s`, `59s`)

#### Scenario: Run duration in minutes
- **WHEN** a run duration is between 60 and 3599 seconds
- **THEN** the dashboard label shows minutes with any leftover whole seconds (e.g. `2m`, `4m 5s`)

#### Scenario: Run duration in hours
- **WHEN** a run duration is 3600 seconds or more
- **THEN** the dashboard label shows hours with any leftover whole minutes (e.g. `1h`, `1h 5m`, `25h 2m`)

#### Scenario: Invalid or unknown duration
- **WHEN** a run duration is undefined, non-finite, or negative
- **THEN** the dashboard omits the duration label when the value is undefined
- **AND** the helper clamps non-finite or negative numeric input to `0s`
