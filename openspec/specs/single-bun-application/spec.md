# single-bun-application Specification

## Purpose
The application ships and runs as one Bun executable: one backend process owns
every domain, no Go child or migration bridge remains, supported external tools
stay explicit dependencies, and historical workflow/environment/telemetry data
and public command aliases keep working. See
`agentic-coding/docs/go-retirement.md`.
## Requirements
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
Current workflow schema v6, current environment schema v9, current JSON config/preferences and current product operations SHALL remain usable after internal bridge deletion. Historical persisted formats SHALL NOT be retained as compatibility shims: they are refused or ignored, never imported or upgraded. The unversioned `/api/*` surface is the current first-party product API rather than an old-format reader, so this change neither renames, removes nor aliases any route.

#### Scenario: Current workflow is opened after cleanup
- **WHEN** the application opens a current v6 workflow store with an exact registered definition pin
- **THEN** it SHALL read and operate on that current-format state without rewriting its schema or pin

#### Scenario: Historical data is refused without mutation
- **WHEN** the application encounters an unsupported workflow or environment schema
- **THEN** it SHALL report or ignore the unsupported format without importing, upgrading, or modifying it

#### Scenario: Current product routes keep serving
- **WHEN** an in-repository caller uses an operation on the unversioned `/api/*` surface
- **THEN** the operation SHALL keep its current behavior, authorization and ordering
- **AND** the surface SHALL stay the current first-party API rather than a compatibility shim for an older data format

