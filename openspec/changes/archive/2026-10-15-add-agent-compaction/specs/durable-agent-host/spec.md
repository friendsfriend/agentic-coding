# Spec Delta: durable-agent-host

## Purpose

The durable agent host's private control protocol additionally serves a manual
compaction request for one run.

## MODIFIED Requirements

### Requirement: Private control protocol
The host SHALL expose a Unix socket in a directory accessible only to the owning user (directory `0700`, socket `0600`) carrying versioned, newline-delimited JSON requests for hello, ensure-run, submit, status, configure-run, catalog, compact-run, abort, stop-run, shutdown and watch. The host SHALL reject frames above a fixed byte bound, unknown protocol versions, and unknown run ids with a structured error. Secrets such as the run capability token SHALL NOT be transmitted over the socket. A compact-run request SHALL carry the run id and optional bounded summarizer instructions, and the host SHALL answer with a structured outcome rather than an error for a run whose conversation has nothing to compact or is already compacting.

#### Scenario: Oversized frame
- **WHEN** a client sends a frame larger than the bound
- **THEN** the host SHALL reject it with an error and keep serving other clients

#### Scenario: Version mismatch
- **WHEN** a client's hello names an unsupported protocol version
- **THEN** the host SHALL refuse the session with a version error

#### Scenario: Compaction for an unknown run
- **WHEN** a compact-run request names a run the host does not track
- **THEN** the host SHALL answer with the unknown-run error code

#### Scenario: Structured compaction outcome
- **WHEN** a compact-run request is answered
- **THEN** the response SHALL carry one of `started`, `already-compacting` or `nothing-to-compact`, with the admitted task identity for `started` and the compaction reason for `already-compacting`
