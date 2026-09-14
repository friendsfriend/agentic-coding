## MODIFIED Requirements

### Requirement: Startup progress feedback
Managed unified TUI launch and home/manager mode SHALL display startup progress until all configured owned backend components are ready. Progress SHALL include history/catalog loading, backend health, telemetry receivers and optional collectors as applicable. Renderer-less commands SHALL use equivalent bounded lifecycle without terminal modal output.

#### Scenario: Home mode shows startup progress
- **WHEN** the TUI starts in managed unified or home/manager mode
- **THEN** it SHALL display startup steps for the configured stack and reflect each step as it completes
- **AND** progress SHALL remain visible until readiness is established

#### Scenario: Startup modal dismissed when server ready
- **WHEN** all configured components pass readiness
- **THEN** the startup modal SHALL close and normal feature interaction SHALL be enabled

#### Scenario: No server stack configured
- **WHEN** a dashboard or attach invocation owns no server stack
- **THEN** it SHALL NOT show server-start progress for unowned components
- **AND** any connection/loading feedback SHALL be distinguished from ownership

### Requirement: Receiver reachable once ready
The OTLP HTTP receiver SHALL accept telemetry at its configured port once startup completes, independently of the currently visible feature tab.

#### Scenario: Spans arrive after startup completes
- **WHEN** startup completes and an agent exports supported OTLP spans to the configured loopback listener
- **THEN** the receiver SHALL acknowledge and store the spans
- **AND** the trace browser SHALL display them when selected

### Requirement: Shutdown progress feedback
Managed TUI quit and SIGINT/SIGTERM/SIGHUP SHALL use one idempotent shutdown flow that stops the owned application stack before exit. Interactive quit SHALL confirm cancellation of active owned actions; signals SHALL perform bounded safe cleanup without waiting indefinitely for interactive input. Progress SHALL be shown when terminal rendering remains available.

#### Scenario: Quit shows shutdown progress
- **WHEN** the user confirms quit of a managed TUI
- **THEN** the TUI SHALL show cancellation, service-stop and persistence/renderer cleanup progress
- **AND** it SHALL exit only after owned cleanup completes or a bounded failure is reported

#### Scenario: Signal-triggered shutdown
- **WHEN** the TUI receives SIGINT, SIGTERM or SIGHUP
- **THEN** the same owned-resource cleanup SHALL run
- **AND** unavailable terminal output SHALL NOT prevent cleanup

#### Scenario: Quit during startup
- **WHEN** the user quits while startup is incomplete
- **THEN** startup SHALL be cancelled and only already-acquired resources SHALL be stopped
- **AND** repeating quit SHALL NOT duplicate cleanup

### Requirement: Guaranteed clean server stop
After successful managed shutdown, no owned application backend/helper process, listener, collector or database handle SHALL remain. Shutdown SHALL distinguish application resources from external containers, tmux sessions and durable Herdr/workflow resources and SHALL NOT destroy them solely because the TUI exits.

#### Scenario: Everything stops before exit
- **WHEN** managed shutdown completes successfully
- **THEN** owned Go/Bun helpers and telemetry listeners SHALL terminate, owned ports SHALL be released, collectors SHALL stop and databases SHALL close
- **AND** the renderer SHALL be destroyed once

#### Scenario: Dashboard mode behavior unchanged
- **WHEN** a per-workflow dashboard with no owned server stack closes
- **THEN** it SHALL release its client/view resources without stopping another application's backend or closing the workflow

#### Scenario: Attach closes
- **WHEN** an attached TUI exits
- **THEN** the attached server SHALL continue running
- **AND** only resources owned by that client SHALL be cancelled

## ADDED Requirements

### Requirement: Backend identity proves ownership
Managed startup SHALL verify spawned process identity, version and effective configuration instance. Listener port or process-name matching SHALL NOT authorize termination.

#### Scenario: Port belongs to another process
- **WHEN** the configured port is occupied by an unrelated or different-instance server
- **THEN** startup SHALL fail clearly or require explicit attachment
- **AND** the application SHALL NOT signal that listener's PID

#### Scenario: Backend becomes ready with wrong identity
- **WHEN** health responds but does not match the spawned instance
- **THEN** startup SHALL reject readiness and clean up only its own child
