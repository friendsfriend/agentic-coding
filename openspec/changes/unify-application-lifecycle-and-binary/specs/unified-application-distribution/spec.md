## ADDED Requirements

### Requirement: One distributable executable
One executable SHALL contain the unified frontend, TypeScript workflow/telemetry code and required runtime assets. While production environment capabilities remain Go-owned, it SHALL also embed their Go backend. Normal launch SHALL NOT require the source repositories or an installed Go compiler. External domain tools SHALL remain documented dependencies.

#### Scenario: Launch outside source checkout
- **WHEN** the compiled artifact runs from an unrelated temporary directory with original checkouts unavailable
- **THEN** environment and workflow feature entrypoints SHALL load their required assets and backend
- **AND** no source-relative path SHALL be required for generated instructions or guides

### Requirement: Compatible command modes
The executable SHALL preserve workflow verbs and home/manager/dash initial-route behavior, provide default unified TUI, server and attach modes, and support a thin devenv command alias. Removed phase-specific workflow verbs SHALL NOT be reintroduced.

#### Scenario: Per-workflow dashboard alias
- **WHEN** `agentic-coding dash` is invoked with an existing repository/workflow identity
- **THEN** it SHALL open that workflow in the shared shell rather than a second independent TUI implementation

#### Scenario: Attach during mixed-runtime milestone
- **WHEN** a client attaches to an environment-only backend
- **THEN** supported environment features SHALL work and unavailable remote workflow capabilities SHALL be identified explicitly
- **AND** local workflow data SHALL NOT be mislabeled as data from the attached server

### Requirement: Embedded helper ownership
While an embedded Go backend is needed, extraction SHALL use a private instance-owned location with safe permissions and cleanup. During the mixed-runtime milestone, optional gRPC support SHALL use an internal mode of the same executable rather than a separate distributed binary. Receivers SHALL bind to loopback by default and pass actual supported protocol readiness; a later in-process implementation SHALL retain these guarantees.

#### Scenario: Optional gRPC listener starts
- **WHEN** gRPC telemetry is configured
- **THEN** the application SHALL verify the supported service accepts a protocol request before marking it ready
- **AND** shutdown SHALL stop the listener, terminate any owned internal-mode helper process and release the port
