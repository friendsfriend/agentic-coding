# tui-server-lifecycle Specification

## Purpose
Defines how the `agentic-coding` TUI (home/manager mode) reports and guarantees the lifecycle of the OTLP server stack it owns — the HTTP receiver, gRPC sidecar, Prometheus scraper, and StatsD listener — so the server is visibly started before use and fully stopped before the TUI exits.
## Requirements
### Requirement: Startup progress feedback
In home/manager mode, while the server stack starts, the TUI SHALL show a startup modal with a progress indicator that remains visible until the server stack is started.

#### Scenario: Home mode shows startup progress
- **WHEN** the TUI starts in home/manager mode
- **THEN** the TUI SHALL display a startup modal listing the server-stack steps (loading workspace history, starting telemetry receiver, starting gRPC sidecar, starting metric collectors as applicable)
- **AND** each step SHALL be reflected in the modal as it completes
- **AND** the modal SHALL remain visible until all server-stack steps have completed

#### Scenario: Startup modal dismissed when server ready
- **WHEN** the server stack has finished starting
- **THEN** the startup modal SHALL close
- **AND** the TUI SHALL accept normal input thereafter

#### Scenario: No server stack configured
- **WHEN** the TUI starts in per-workflow dashboard mode (no receiver stack)
- **THEN** no startup modal SHALL be shown

### Requirement: Receiver reachable once ready
The OTLP HTTP receiver SHALL accept telemetry at its configured port once the startup modal closes.

#### Scenario: Spans arrive after startup completes
- **WHEN** the startup modal closes and an agent exports OTLP spans to `127.0.0.1:4318`
- **THEN** the receiver SHALL acknowledge and store the spans
- **AND** the trace browser SHALL display them

### Requirement: Shutdown progress feedback
In home/manager mode, on a normal quit request (`q` / double-`q`) or an OS signal (SIGINT/SIGTERM/SIGHUP), the TUI SHALL show a shutdown modal with a progress indicator and SHALL NOT exit before the server stack is stopped.

#### Scenario: Quit shows shutdown progress
- **WHEN** the user quits the TUI in home/manager mode
- **THEN** the TUI SHALL display a shutdown modal listing the server-stack stop steps
- **AND** each stop step SHALL be reflected in the modal as it completes
- **AND** the TUI process SHALL exit only after the server-stack stop has completed

#### Scenario: Signal-triggered shutdown
- **WHEN** the TUI receives SIGINT, SIGTERM, or SIGHUP in home/manager mode
- **THEN** the same shutdown modal flow SHALL run (stop sequence with progress before exit)

#### Scenario: Quit during startup
- **WHEN** the user quits while the startup modal is still shown
- **THEN** the startup SHALL be abandoned
- **AND** the shutdown flow SHALL stop whatever server components already started
- **AND** the TUI SHALL exit

### Requirement: Guaranteed clean server stop
When the TUI exits in home/manager mode, the server stack SHALL be fully stopped and no orphaned processes or bound ports SHALL remain.

#### Scenario: Everything stops before exit
- **WHEN** the TUI exits after the shutdown flow
- **THEN** the HTTP receiver server SHALL be stopped and port 4318 (or the configured port) SHALL be released
- **AND** the gRPC sidecar process SHALL have terminated
- **AND** the Prometheus scraper and StatsD listener SHALL have stopped
- **AND** the trace DB SHALL be closed
- **AND** the TUI process SHALL have exited

#### Scenario: Dashboard mode behavior unchanged
- **WHEN** the user quits a per-workflow dashboard (no receiver stack)
- **THEN** the existing dashboard quit behavior SHALL be preserved unchanged

