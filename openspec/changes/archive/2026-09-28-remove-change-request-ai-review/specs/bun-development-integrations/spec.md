# Spec Delta

## Purpose

Removes the change-request AI review from the integration surface: logs and
sessions remain the AI family's work, and no route answers without the instance
bearer token.

## MODIFIED Requirements

### Requirement: Scoped AI streaming and session discovery

Bun SHALL preserve supported Pi session discovery and streamed log analysis.
Session parsing SHALL remain bounded, and a stream that closes or is cancelled
SHALL stop its own work without affecting unrelated resources.

#### Scenario: Session file is malformed or oversized

- **WHEN** session discovery reads invalid or excessive JSONL content
- **THEN** parsing SHALL remain bounded and report/skip the invalid record
  without executing content or crashing the entire list

#### Scenario: Analysis stream disconnects

- **WHEN** a log analysis stream closes or is cancelled
- **THEN** the analysis work SHALL stop
- **AND** secret values SHALL NOT enter logs or history

### Requirement: Single route and mutation ownership

Each integration route/capability SHALL have exactly one runtime owner at
cutover, and every route SHALL require the instance bearer token. There SHALL be
no route whose authorization is a capability carried in its path. Compatibility
evidence SHALL use fixtures or isolated test systems rather than duplicate real
mutations.

#### Scenario: Response is lost after provider write

- **WHEN** a provider write may have committed before transport failure
- **THEN** the client/backend SHALL reconcile using operation semantics rather
  than automatically submit the same mutation to both runtimes

#### Scenario: Unauthenticated request

- **WHEN** a request carries no instance bearer token
- **THEN** it SHALL be rejected, except for the exact `GET /api/health`
  liveness probe
- **AND** no path-shaped capability SHALL exempt any other route
