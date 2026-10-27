## Why

Durable pi-durable tasks can fail or become parked after native crash-loop protection, but the host and agent views do not yet give developers a complete, actionable account of those failures. This change proposes bounded diagnostics and explicit, ownership-checked recovery that preserves native protections and avoids claiming exactly-once side effects.

## What Changes

- Connect structured durable-runtime failure reports to host diagnostics and runtime event delivery.
- Expose parked-task identity and restart-limit reason with a deliberate, safe retry path.
- Surface retained compaction failures and their success-clearing lifecycle in agent views.
- Keep runtime failure reporting distinct from workflow completion, developer questions, and gates.

## Capabilities

### New Capabilities
- `durable-failure-recovery`: Host reporting, failure visibility, explicit retry of parked tasks, and compaction failure lifecycle.

### Modified Capabilities

## Impact

- Likely host integration in `agentic-coding/src/agent-host/host.ts`, runtime event contracts and server/dashboard agent views/actions.
- Depends on pi-durable 1.4.0 public APIs and requires isolated-storage tests for report, parking, retry, and compaction failure behavior.
