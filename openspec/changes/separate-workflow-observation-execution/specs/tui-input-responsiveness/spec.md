## ADDED Requirements

### Requirement: Slow workflow observations do not block input
Git/Herdr observations, substantial artifact/telemetry collection, and long-running effect or preflight subprocess work initiated by the TUI SHALL execute outside synchronous render/input callbacks. Observations SHALL have bounded execution, one in-flight refresh per view, explicit loading/error state, and disposal-aware result handling.

#### Scenario: Observation subprocess is delayed
- **WHEN** a Git or Herdr observation remains unresolved
- **THEN** renderer input and navigation SHALL continue processing
- **AND** prior observations SHALL remain visible with loading state rather than blocking the UI

#### Scenario: Refresh arrives during refresh
- **WHEN** additional refresh requests arrive while observation collection is in flight
- **THEN** the view SHALL coalesce them into a bounded latest refresh rather than spawning unbounded overlapping work

#### Scenario: Selection changes before observation resolves
- **WHEN** an observation resolves after navigation to another workflow or component disposal
- **THEN** its stale result SHALL not overwrite the newly selected workflow's display
- **AND** owned timers and cancellable operations SHALL be disposed

#### Scenario: Observation fails
- **WHEN** an observation times out or returns an error
- **THEN** the dashboard SHALL expose the failure without reporting it as committed workflow completion
- **AND** input, navigation, and a later refresh SHALL remain usable
