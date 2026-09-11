## ADDED Requirements

### Requirement: One Bun backend without Go fallback
All application backend domains SHALL run in one Bun server process with no Go child, Go runtime dependency or fallback adapter. One executable SHALL provide TUI/server/attach and retained command aliases; TUI and server modes can run as separate invocations of that executable.

#### Scenario: Go and source checkouts are absent
- **WHEN** the packaged application runs without Go installed and without either source checkout
- **THEN** all supported baseline feature journeys SHALL work using bundled assets and documented external domain tools
- **AND** process inspection SHALL find no application-owned Go server or migration bridge

### Requirement: Verified parity gates deletion
Go source/build paths and migration-only adapters SHALL be removed only after every baseline feature/route/action has a tested Bun owner. Portable compatibility fixtures and historical data support SHALL survive removal.

#### Scenario: Inventory still lists Go owner
- **WHEN** a production capability still depends on Go
- **THEN** final retirement SHALL be blocked
- **AND** removing its UI entrypoint SHALL NOT satisfy the gate

### Requirement: Supported telemetry shares backend lifecycle
Supported optional gRPC and other telemetry receivers SHALL run under the Bun server lifecycle with actual protocol readiness, loopback-default binding and clean shutdown. Unsupported protocol variants SHALL NOT be advertised as implemented.

#### Scenario: gRPC telemetry is enabled
- **WHEN** a supported gRPC export arrives
- **THEN** the single backend process SHALL decode/ingest it and expose the result through telemetry views
- **AND** no separate permanent gRPC backend process SHALL be required

### Requirement: Compatibility outlives internal bridges
Supported workflow definitions/pins, data/config formats and public CLI aliases SHALL remain compatible after internal bridge deletion. Removed legacy phase-specific workflow verbs SHALL remain removed.

#### Scenario: Historical workflow is opened after retirement
- **WHEN** a supported old workflow references a retained definition/behavior identity
- **THEN** the application SHALL read it under existing validation/migration rules without dropping its pin for cleanup convenience

#### Scenario: Operator rolls back artifact
- **WHEN** rollback requires an older schema writer
- **THEN** documentation SHALL require quiescent ownership and a verified compatible/pre-upgrade database
- **AND** the application SHALL NOT automatically downgrade live data
