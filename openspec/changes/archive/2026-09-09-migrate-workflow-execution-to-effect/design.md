## Context

`EffectRunner.drain` currently claims one outbox row, creates a renewal interval and AbortController, observes or executes a handler, dispatches a lease-bound result, and cleans up. Adapters and credential code add process polling, Promise races, filesystem resources, and external ownership recovery. `withWikiRoot` temporarily changes process-wide environment. Existing tests cover slow leases, takeover, stable launch identity, reused versus owned panes, and crash observation.

Phase 2 supplies Effect-native engine/store/startup operations and shared concrete I/O boundaries. This phase migrates execution end to end rather than leaving the existing runner behind one Promise adapter.

## Goals / Non-Goals

**Goals:** standard scoped execution agents can extend safely; explicit expected failures; real cancellation; preserved idempotency, lease fencing, security, and external ownership; deterministic timing checks.

**Non-goals:** changing serial capacity, introducing a durable workflow library, making process interruption equivalent to rollback, or inventing a generic saga framework.

## Decisions

### 1. One scope per claimed execution, not per durable agent lifetime

Claim one effect only when the serial runner can start it. Inside its execution scope, start a supervised renewal task using the same clock as the store. Renew through the engine service at the established cadence, bounded by the operation deadline. Rejected renewal or renewal failure interrupts execution and prevents new external work; renewal exceptions must not escape as unhandled timer errors. Never renew an already expired lease.

Observation, execution, renewal, and finalization share ownership context. Stop/join renewal on scope exit and retain final transactional lease validation for completion. Cancellation alone cannot close the race between a final remote call and lease replacement; durable token checks and reconciliation remain mandatory.

Temporary processes, stream readers, FIFO files, listeners, and credential requests belong to the execution scope. Successfully launched managed agents, adopted panes, and created workspaces can belong to the durable workflow and intentionally outlive a drain. Explicitly transfer ownership once the existing protocol establishes it; ordinary successful scope exit must not stop those resources. On lease loss or failure, cleanup uses exact identity/current ownership checks and must not destroy resources adopted by a successor. If ownership is uncertain, expose attention/reconciliation rather than perform destructive cleanup.

Alternative: put every external resource in unconditional acquire/release. Rejected because it would kill successfully launched agents when the short-lived runner exits.

### 2. Persisted outbox remains the retry authority

Keep effect identity, claim-as-attempt, `max_attempts`, `next_attempt_at`, expiry recovery, and operator reset policy in SQLite. Use Effect schedules for heartbeat, bounded polling, and waking at the next persisted deadline, not for silently re-running a mutating handler under one recorded attempt. Preserve the existing durable backoff formula and serial ordering.

Use typed recovery policy: confirmed transient failures request the next durable retry; known permanent configuration/validation failures enter attention immediately; ownership loss cannot publish a result under the old lease; interruption stops work without claiming completion; defects or uncertain external completion are surfaced conservatively rather than treated as generic retryable exceptions. Classify existing handler failures explicitly with tests. Do not classify remote writes as safe merely because a network error looks transient.

Every permitted recovery observes existing completion before re-execution. Observation distinguishes confirmed absence, confirmed completion, and inability to determine state. An observation failure must not be treated as confirmed absence that authorizes duplicating external work. Remote systems without idempotency support still require stable identity and reconciliation; Effect cannot supply exactly-once semantics.

### 3. Migrate adapters rather than layering a second client over them

Move all registered handler bodies to Effect operations. Use the existing shared Herdr envelope parser once and expose workflow-facing operations through the shared service. Decode untrusted Herdr/process/configuration envelopes with Schema at the appropriate boundary. Retain pure assignment rendering, canonical agent naming, path calculations, and data transforms as plain functions.

Use supported Effect platform services when they match requirements; otherwise use small native Bun/FFI adapters with Effect acquisition, error conversion, and cancellation. Promise conversion is allowed only at genuine foreign API boundaries. Plain wrappers around entire legacy launch/git/wiki orchestration functions are not final implementations. Shared clients used outside workflow can retain native transport APIs, but migrated workflow consumers use the Effect boundary and do not duplicate parsing.

Subprocess operations collect bounded output, distinguish exit failure from timeout/cancellation, propagate interruption to the real child, and await bounded termination/reader cleanup. Document supported process-tree termination behavior and test descendants involved in credential relays; detached managed agents use the explicit lifecycle service, not accidental process-group killing. Do not claim `Effect.sync` makes blocking operations asynchronous. Short descriptor-relative security operations remain native boundary primitives with their safety checks intact; replace blocking polling and slow subprocess/file walks with cancellable asynchronous operations.

### 4. Credentials and wiki roots are operation-local

Credential acquisition scopes own the askpass shim, FIFO readers/writers, subprocess, and UI request. Process exit, timeout, ownership loss, or UI cancellation resolves the pending request without leaked children or retained secret values. FIFO rendezvous itself must be bounded/cancellable; racing an uncancellable Promise and forgetting it is insufficient. Preserve masking and 0700/0600 access constraints and never persist or trace secrets.

Pass pinned wiki root explicitly or as an immutable operation-provided service to wiki reads/writes. Set environment only in child process launch options. Do not implement a scoped global `process.env` mutation: two CLI/dashboard operations may overlap even with serial outbox execution. Preserve pinned-root validation, source isolation, snapshot security, and repository-independent layout.

### 5. Keep virtual-time and real-world checks separate

Use Effect test clock and fake services for renewal cadence, interruption, retry deadlines, and cleanup order. Synchronize tests on task readiness before advancing time; avoid replacing real sleeps with arbitrary virtual advances that race fiber startup. Engine validation and runner timers share the same test clock.

Keep real temporary SQLite/multi-process ownership tests, subprocess/credential termination tests, and crash-after-external-success recovery checks. Test interrupted acquisition, renewal exceptions, cleanup failure, reused resource ownership, and successful durable agent survival. Finalizer errors remain observable without replacing the original failure or falsely committing success.

## Risks / Trade-offs

- Scoped cleanup destroys durable resources -> explicit transfer and successor-ownership tests.
- Nested retry multiplies attempts -> engine owns accounting; assert exact claims/executions under failure and restart.
- Interruption only stops waiting -> test actual process/reader termination and bounded FIFO cleanup.
- Typed transient classification changes behavior -> enumerate handler failures, explicitly fail permanent cases, retain uncertain-completion safety.
- Platform convenience APIs weaken secure files -> preserve descriptor-relative no-follow access, atomic publication, permissions, and adversarial tests.

## Migration Plan

Migrate runner ownership and its tests, then process/Herdr/credentials, handler groups, and wiki/filesystem context. Keep the registered handler inventory complete at each stage through short-lived listed bridges. No legacy runner remains after this phase; outer CLI/TUI runtime bridges are removed in phase 4.

Deploy compatible runner versions together and stop old execution owners before switch. No store-format migration is planned. Rollback only to a binary supporting the current store and renewable lease lifecycle. Pending rows resume through the same observation/claim rules, never by assuming scope cleanup reversed external work.
