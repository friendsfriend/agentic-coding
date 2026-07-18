## ADDED Requirements

### Requirement: Standalone local trace viewer
The system SHALL provide independently runnable `otel-tui` executable that receives OTLP/HTTP JSON traces and renders them in terminal.

#### Scenario: Viewer starts with defaults
- **WHEN** developer runs `otel-tui` without network arguments
- **THEN** viewer SHALL bind OTLP HTTP receiver to `127.0.0.1:4318`
- **AND** viewer SHALL display newly received spans without restart

#### Scenario: Other application exports traces
- **WHEN** application sends valid OTLP/HTTP JSON request to `POST /v1/traces`
- **THEN** receiver SHALL acknowledge accepted spans
- **AND** trace browser SHALL make those traces available independent of Herdr workflow

#### Scenario: Viewer loads local history
- **WHEN** developer supplies normalized trace JSONL file through viewer CLI
- **THEN** viewer SHALL load valid historical spans and continue following new records
- **AND** malformed lines SHALL be skipped without terminating viewer

### Requirement: Trace-oriented terminal navigation
The trace viewer SHALL group spans by trace and expose parent/child hierarchy, timing, status, service, and attributes.

#### Scenario: Developer inspects trace
- **WHEN** developer selects trace and span
- **THEN** viewer SHALL show span tree in parent/child order
- **AND** selected span detail SHALL show name, duration, status, resource/service identity, and normalized attributes

#### Scenario: Developer filters traces
- **WHEN** developer enters text filter
- **THEN** viewer SHALL limit visible traces using span names, service names, trace IDs, and attribute values
- **AND** clearing filter SHALL restore retained traces

#### Scenario: New spans complete live
- **WHEN** receiver accepts additional spans for visible trace
- **THEN** viewer SHALL update trace and span hierarchy while preserving valid selection where possible

### Requirement: Managed workflow dashboard trace browser
The Herdr dashboard SHALL expose same trace browser for selected workflow's local trace history.

#### Scenario: Developer opens dashboard traces
- **WHEN** developer activates Traces panel in `agent-dash`
- **THEN** dashboard SHALL load selected workflow's normalized trace JSONL
- **AND** browser SHALL prefilter spans to selected workflow change

#### Scenario: Workflow has no spans yet
- **WHEN** selected workflow has no trace file or valid spans
- **THEN** dashboard SHALL show empty trace state
- **AND** remaining workflow dashboard SHALL continue operating

### Requirement: Bounded and safe trace ingestion
The standalone receiver SHALL validate untrusted network payloads and bound memory use.

#### Scenario: Request is malformed or unsupported
- **WHEN** receiver gets invalid JSON, invalid span identifiers/timestamps, unsupported content type, wrong path, or oversized body
- **THEN** receiver SHALL return non-success response or OTLP partial-success result
- **AND** viewer SHALL remain running

#### Scenario: Retention limit is reached
- **WHEN** accepted spans exceed configured maximum
- **THEN** viewer SHALL evict oldest retained spans
- **AND** memory retention SHALL remain bounded

#### Scenario: Non-loopback exposure is requested
- **WHEN** developer explicitly supplies non-loopback host
- **THEN** viewer SHALL bind requested host
- **AND** CLI/help SHALL state receiver has no authentication and should remain locally protected

### Requirement: Viewer packaging
Build and install workflow SHALL produce `otel-tui` alongside `agent-dash` for supported current target.

#### Scenario: Current-platform install runs
- **WHEN** developer runs existing dashboard binary installation flow
- **THEN** build SHALL compile both executables for current platform
- **AND** installer SHALL place both executables in same user bin directory

#### Scenario: Cross-platform build runs
- **WHEN** maintainer runs all-target build
- **THEN** every supported package SHALL contain matching `agent-dash` and `otel-tui` binaries
