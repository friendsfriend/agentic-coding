# Spec Delta

## Purpose

Agents read traces, data and API responses of their own instances, with every
span attributed to an instance and every access bounded and read-only.

## ADDED Requirements

### Requirement: Instances export traces to the local receiver

Every instance SHALL receive OTel endpoint, service name and resource attributes identifying instance, owner and app, resolved for its runtime; the receiver SHALL NOT bind a wildcard address.

#### Scenario: Script instance

- **WHEN** a script instance starts without its own `OTEL_*` settings
- **THEN** it SHALL receive `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at the local receiver and `OTEL_RESOURCE_ATTRIBUTES` containing `ac.instance`

### Requirement: Trace query is scoped to the owner

`otel_query` SHALL return only spans whose `ac.instance` belongs to the calling owner, as bounded trace summaries or one bounded span tree.

#### Scenario: Error trace

- **WHEN** an agent queries `status: error` after a failing request
- **THEN** the result SHALL list the failing trace and its span tree SHALL include the exception event

### Requirement: Database access is read-only and bounded

`db_query` SHALL run in a read-only transaction scoped to the instance schema with a statement timeout and row cap, SHALL always roll back, and SHALL refuse infra without isolation and the `user` instance.

#### Scenario: Write attempt

- **WHEN** an agent runs `UPDATE` through `db_query`
- **THEN** the database SHALL reject it inside the read-only transaction and no change SHALL persist

### Requirement: HTTP calls target own instances

`http_request` SHALL only call endpoints of the owner's instances and SHALL return a size-capped, redacted response.

#### Scenario: Foreign host

- **WHEN** an agent calls `http_request` with a URL outside its instances
- **THEN** the tool SHALL refuse it
