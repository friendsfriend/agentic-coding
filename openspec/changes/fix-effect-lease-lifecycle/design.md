## Context

`EffectRunner.drain()` claims up to 20 effects at once, then executes them serially. `WorkflowEngine.claimEffects()` grants 30-second leases and increments attempts, including expired-running rows without checking their budget. `effectIsLive()` ignores expiry, while the result reducer rejects it. Credential interaction alone can exceed 30 seconds.

## Goals / Non-Goals

**Goals:** valid ownership throughout execution, bounded recovery, no duplicated accepted result, and deterministic fault tests.

**Non-goals:** exactly-once external side effects, a daemon, parallel worker scheduling, or workflow semantic changes.

## Decisions

### Claim only executable work

Keep the current serial runner and claim one effect immediately before processing it. This is smaller than reserving batches and renewing idle reservations. Preserve a bounded drain budget; claim limits remain an engine API, not a guarantee that every caller may preclaim idle work safely.

### One lease validity predicate and clock

Use the engine's injected clock for claim, renewal, liveness, and result acceptance. Ownership requires running status, matching token, and an unexpired deadline. Renew with a compare-and-set update only while ownership is still live. An expired owner cannot revive its lease, even if no successor has claimed it yet.

Run a renewal timer only around active handler observation/execution and always dispose it. Convert potentially long blocking subprocess calls on this path to cancellable asynchronous calls with explicit deadlines so they cannot starve renewal. Retain credentials interaction and its bounded waiting behavior; do not increase a global lease indefinitely to mask blocking operations.

### Exhaustion includes crashes and expiry

Every claim consumes an attempt. When an expired running row has exhausted its budget, transactionally mark it failed and place its workflow in attention-required with an event instead of executing again. Preserve the idempotency key and existing explicit retry action; a deliberate operator retry is distinct from automatic recovery and has an explicit bounded budget.

### Ownership loss is not success

On renewal failure, stop starting additional external actions and cancel the owned subprocess when supported. Never accept an expired result. Run cleanup only for resources known to belong to the losing execution; do not close an agent/workspace adopted by a successor. Existing observe-before-retry logic remains required because a crash can occur after an external operation succeeds but before its result commits.

## Risks / Trade-offs

- Serial claiming lowers throughput relative to future parallel workers → current runner is already serial; add concurrency only after measurement.
- Cancellation cannot undo a completed push or workspace creation → retain observation and stable external identity, and fail closed when completion is uncertain.
- Renewal can race with repair/closure → token-bound CAS and tests must prevent revival or cleanup of successor-owned resources.

## Migration Plan

Reuse outbox columns and existing keys. Stop old drainers before deploying the fix; mixed runner versions retain the old failure mode. Previously expired over-budget effects become visible failures on the next execution pass. No destructive data migration is needed. Rollback restores the known lease bug and must not be treated as a recovery strategy.
