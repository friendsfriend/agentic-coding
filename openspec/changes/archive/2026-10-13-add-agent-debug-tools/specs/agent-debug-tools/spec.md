# Spec Delta

## Purpose

Agents read traces, data and API responses of the apps their workflow holds.
Every span is attributed to the workflow run that produced it, and every access
is bounded and read-only.

## ADDED Requirements

### Requirement: App runs export attributed traces to the local receiver

Every app run SHALL receive an OTel endpoint, a service name and resource attributes identifying the app, the owner and the slot grant, resolved for its runtime; the receiver SHALL NOT bind a wildcard address.

#### Scenario: Script run

- **WHEN** a script run starts without its own `OTEL_*` settings
- **THEN** it SHALL receive `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at the local receiver and `OTEL_RESOURCE_ATTRIBUTES` containing `ac.owner` and `ac.run`

### Requirement: Trace query is scoped to the workflow's runs

`otel_query` SHALL return only spans whose `ac.owner` is the calling workflow, as bounded trace summaries or one bounded span tree.

#### Scenario: Previous holder's traces

- **WHEN** `workflow:a` ran `customer-mw`, released it, and `workflow:b` now queries traces of `customer-mw`
- **THEN** `workflow:a`'s spans SHALL NOT appear in `workflow:b`'s result

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
