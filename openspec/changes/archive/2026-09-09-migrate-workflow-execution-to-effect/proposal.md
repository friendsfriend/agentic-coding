## Why

The runner and adapters contain the densest custom concurrency, cancellation, retry, subprocess, and cleanup logic. Converting these together gives agents one standard execution pattern rather than Effect wrappers around the same manual lifecycle machinery.

## What Changes

- Replace manual runner timers and Promise orchestration with scoped Effect execution and supervised lease renewal, while retaining serial just-in-time claims.
- Migrate every registered handler and workflow-facing Herdr/Git/process, filesystem, credentials, wiki, assignment/asset I/O, and adapter operation to concrete Effect boundaries.
- Preserve durable attempt accounting and observe-before-execute recovery; distinguish transient failure, permanent failure, ownership loss, interruption, and defects.
- Wire interruption to actual child processes and credential waits with bounded cleanup; preserve ownership transfer for agents/workspaces that must outlive a drain.
- Replace temporary process-wide wiki environment mutation with explicit operation-scoped context and child-only environment values.
- Replace timer-sensitive unit checks with Effect test-clock/service tests while retaining real subprocess, SQLite, and crash-recovery checks.
- **BREAKING:** Internal handler/adapter APIs become Effect-native. Known permanent failures stop retrying earlier instead of consuming the full transient retry budget; external command and persisted record formats remain unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-state-runtime`: Scoped execution ownership, classified failure/retry handling, and explicit per-operation external context.
- `herdr-workflow-testability`: Deterministic Effect timing tests plus real cancellation/recovery contract checks.

## Impact

- Depends on `migrate-workflow-runtime-to-effect` and its prerequisites.
- Code: `effect-runner.ts`, `adapters.ts`, external portions of `effects.ts`, `credentials.ts`, `wiki.ts`, `secure-fs.ts`, assignment/assets I/O, shared `herdr-client.ts`, and corresponding tests/callers.
- Reuse phase-2 services and existing shared Herdr envelope parser. Add version-compatible Effect platform packages only where they replace a real boundary implementation.
- Scope includes all thirteen current `EffectKind` handlers and any kinds registered before implementation; final coverage is checked against the registry, not this prose count.

## Non-goals

No parallel worker pool, in-memory replacement for durable retries, automatic compensation of arbitrary remote operations, global environment mutation hidden in a Layer, or redesign of the agent protocol.
