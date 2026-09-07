## Context

`WorkflowEngine` currently opens synchronous SQLite handles, controls `BEGIN IMMEDIATE` transactions, validates commands and snapshots, and delegates to runtime modules. Startup mixes configuration, Git, executable checks, and pure routing. Domain correctness depends on authorization, exact developer revisions, active run generations, effect lease tokens, and retained semantic definitions.

Implement against the landed observation/execution and completion-behavior proposals, not today's intermediate file layout. Those changes own secure evidence preparation and step semantics. Phase 1 supplies Schema, failures, the locked Effect version, and migration inventory.

## Goals / Non-Goals

**Goals:** Effect-native engine/application operations, explicit live/test dependencies, safe transaction ownership, deterministic clock use, unchanged command/security/durability behavior.

**Non-goals:** replacing SQLite with Effect STM, moving authorization into handlers, running asynchronous work inside write transactions, or creating service layers for pure helpers.

## Decisions

### 1. Migrate real boundaries, not every function

Expose start, dispatch, initialization, status/list/snapshot reads, repair/migration previews, claim/renew/liveness, and capability operations as Effect programs. Introduce concrete store/configuration/evidence services only with their implementations and consumers. Reuse Effect's clock and platform services where they fit; preserve a configured registry as an immutable dependency. Layers assemble implementations at the application boundary; business modules do not instantiate production dependencies.

Keep definitions, routing transformations, step hooks, hashing over supplied data, projection, and formatting pure. Expected rejection from pure decisions uses the chosen release's synchronous typed result representation and is lifted once by the application boundary. A migration adapter can recognize historical tagged throws until its callers move; final code must not rely on message matching or a second exception-based engine path.

Alternative: retain `WorkflowEngine` unchanged behind one `Effect.try` call. Rejected as the final design: it hides ambient I/O and dependency/failure behavior rather than establishing the programming model agents need. Internal synchronous SQL primitives remain valid implementation details, not an excuse to preserve whole orchestration classes unchanged.

### 2. Preserve a non-suspending SQLite critical section

A store service owns connection acquisition/close and wraps the existing synchronous transaction primitive as one bounded operation. Once `BEGIN IMMEDIATE` succeeds, snapshot reload, authorization, pure reduction, invariant validation, state/event/outbox writes, and commit/rollback run synchronously on that handle. Do not `yield*`, await, sleep, retry, or call `runSync`/`runPromise` inside the SQL transaction callback. Do not use Effect STM as a substitute for SQL atomicity.

Acquire resources with a scope so open failure, command failure, and interruption cannot leak connections. A pending interruption can take effect before transaction entry or after the atomic section, never between its writes. Synchronous work is not made nonblocking by wrapping it; retain bounded SQL and necessary security primitives here, and move slow preparation outside. Test SQLite lock contention and bounded wait behavior; unexpected long blocking is a release issue, not something fibers repair automatically.

Separate the committed result from post-commit scheduling/telemetry. If commit succeeds but interruption or a notification failure occurs before the caller sees success, durable state remains committed. Do not replay the mutation or describe it as rolled back. Continuation can recover pending outbox work. If commit outcome cannot be established after an I/O failure, expose uncertainty and require reread/reconciliation rather than blind retry. Preserve the existing narrowly scoped rejection-audit policy separately from workflow state/event/outbox atomicity.

### 3. Use one real/test clock for ownership decisions

Effect's clock supplies timestamps for claims, renewals, liveness, expiry, and command validation. Capture explicit time immediately at the synchronous transaction decision boundary after writer-lock acquisition; do not use a timestamp sampled before an unbounded lock wait. Supply it to pure functions without ambient clocks. The store adapter may use an injected synchronous clock reader for this non-suspending boundary, backed by the same live/test clock as surrounding Effect timers. Do not introduce a second independently advancing fake clock.

### 4. Preserve security during asynchronous preparation

Implement the prerequisite authenticated, bounded evidence preparation as an Effect operation. Keep prepared evidence bound to run/workflow, generation, relevant revision/source identity, and captured content. Reauthorize inside the transaction and preserve final integrity checks or immutable evidence captures required by the existing security contract. A sibling handoff may advance revision without invalidating another still-active run; do not replace run-generation rules with universal exact-revision matching.

Wrap descriptor-relative secure filesystem operations in their boundary service without replacing no-follow/atomic publication with convenience path APIs. Credentials and capability tokens never enter persisted Effect service/config values or traces. Unsupported stores/pins still fail closed. Initialization is explicit; reads remain non-mutating.

### 5. Startup shares services rather than CLI imports

Move configuration reads, project target resolution, Git preflight, executable/model discovery, and startup preparation behind Effect operations available to CLI and dashboard. Parse external configuration at its boundary with Schema while retaining existing TOML precedence, environment provenance, pinned non-secret settings, and repository-independent/worktree behavior. Pure routing receives decoded values.

Where shared Git/process infrastructure is needed now, introduce the concrete async boundary here and reuse/complete it in phase 3. Do not maintain a second process client. Keep transitional runtime runners only at listed unmigrated outer callers; a legacy caller needing asynchronous work must become async, not force the program through `runSync`.

## Risks / Trade-offs

- API conversion touches many callers -> inventory every import and keep each phase buildable through explicit temporary boundary bridges.
- Cancellation around commit causes duplicate mutation -> expose committed identity/revision and distinguish execution failure from post-commit delivery failure.
- Async evidence changes security -> reuse prerequisite binding policy and adversarial artifact/source replacement tests.
- Synchronous SQLite blocks fibers -> short critical sections, explicit contention tests, no slow filesystem/Git work under the writer lock except required bounded integrity primitives.
- Foreign services outlive a transaction -> expose transaction-scoped handle only to the synchronous callback, never to concurrent fibers.

## Migration Plan

Verify prerequisites are landed, then migrate read/initialization paths, command transactions/security, ownership methods, and startup. Keep existing external behavior and semantic digests. Migrate focused tests to run effects with test services; preserve real SQLite and multi-process tests for actual durability.

Rollback to a compatible binary requires no Effect-specific data downgrade because this proposal adds no schema or pin changes. Stop affected execution owners during deployment. Never run old non-renewing drainers against the migrated lifecycle or roll back a separately upgraded store with an unsupported binary.
