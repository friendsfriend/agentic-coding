## ADDED Requirements

### Requirement: Browser results identify the observed state and carry timing
A `browser_snapshot` result SHALL carry a `snapshotId` and the refs that belong to that state. A browser action result SHALL carry the resulting `snapshotId` and a compact observation, and SHALL NOT carry the full page tree. `browser_run_script` MAY carry the same compact observation when `observe` is requested. Every browser snapshot, action, diff, find and script result SHALL carry timing fields for the snapshot, action and observation work plus the returned character and ref counts. The detailed observation, scoped/diff/find, batching, one-release legacy rollback and mandatory removal rules are defined by the `browser-observation-loop` capability.

#### Scenario: Action identifies its result state
- **WHEN** an agent clicks a ref from snapshot `s7`
- **THEN** the action result SHALL name the resulting `snapshotId` and include a compact observation rather than a full tree

#### Scenario: Timing is available
- **WHEN** an agent takes a snapshot or performs an action
- **THEN** the result SHALL include the relevant timing and size fields

#### Scenario: Script observation is opt-in
- **WHEN** an agent runs `browser_run_script` without `observe`
- **THEN** the result SHALL contain the script result and timing but SHALL not include an automatic page observation
