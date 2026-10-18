# agent-debug-tools Specification

## Purpose
TBD - created by archiving change add-agent-debug-tools. Update Purpose after archive.
## Requirements
### Requirement: App runs export attributed traces to the local receiver

Every app run SHALL receive an OTel endpoint, a service name and resource attributes identifying the app, the owner and the slot grant, resolved for its runtime; the receiver SHALL NOT bind a wildcard address.

#### Scenario: Script run

- **WHEN** a script run starts without its own `OTEL_*` settings
- **THEN** it SHALL receive `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at the local receiver and `OTEL_RESOURCE_ATTRIBUTES` containing `ac.owner` and `ac.run`

### Requirement: Trace query is scoped to the workflow's runs

`otel_query` SHALL return only spans whose `ac.owner` is the calling workflow, as bounded trace summaries or one bounded span tree. The trace list SHALL rank request traces before single-span background traffic (a poller's query, for example), SHALL report how many matching traces the default ranking pushed out of the answer, and SHALL accept `minSpans`, `rootKind`, `http`, `excludeNames`, `includeNoise` and `status` filters that replace the default ranking when they are given.

#### Scenario: Previous holder's traces

- **WHEN** `workflow:a` ran `customer-mw`, released it, and `workflow:b` now queries traces of `customer-mw`
- **THEN** `workflow:a`'s spans SHALL NOT appear in `workflow:b`'s result

#### Scenario: A poller floods the list

- **WHEN** an app polls its database twice a second and the newest traces are all single-span queries
- **THEN** the request trace SHALL be ranked first, and the answer SHALL report how many background traces were dropped and how to see them

### Requirement: Log records are queryable by their workflow and trace

`otel_query` SHALL answer the OTLP log records the workflow's runs exported, attributed by the same `ac.owner`, as bounded rows (time, severity, a bounded body, service, trace id, span id and bounded attributes) filtered by `traceId`, `severity`, `text` and `since`. A server that receives no telemetry SHALL answer `log-index-unavailable` rather than silently returning spans.

#### Scenario: The log lines of one request

- **WHEN** an agent queries `otel_query` with `mode: "logs"` and the `traceId` of a failing request
- **THEN** the answer SHALL be that request's log lines, redacted and bounded, and SHALL never include another workflow's records

### Requirement: Database access is read-only and bounded

`db_query` SHALL run in a read-only transaction with a statement timeout and row cap, SHALL always roll back, and SHALL be allowed only for infra with a declared query connection that a held app of the workflow requires.

#### Scenario: Write attempt

- **WHEN** an agent runs `UPDATE` through `db_query`
- **THEN** the database SHALL reject it inside the read-only transaction and no change SHALL persist

### Requirement: HTTP calls target held apps

`http_request` SHALL only call static endpoints of apps the calling workflow holds and SHALL return a size-capped, redacted response.

#### Scenario: App not held

- **WHEN** an agent calls `http_request` for an app another workflow holds
- **THEN** the tool SHALL refuse naming the holder

