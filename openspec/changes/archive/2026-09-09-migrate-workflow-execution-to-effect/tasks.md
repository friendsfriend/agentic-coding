## 1. Scoped runner

- [x] 1.1 Inventory every registered EffectKind/handler and classify current failures, recovery observations, durable resources, temporary resources, and native boundaries.
- [x] 1.2 Replace manual renewal timers and runner Promise orchestration with one execution scope and supervised renewal using the engine clock; retain serial just-in-time claims and final lease validation.
- [x] 1.3 Implement typed transient/permanent/ownership/interruption/defect policy with persisted retry accounting; distinguish failed observation from confirmed absence and prohibit hidden handler retry loops.
- [x] 1.4 Add focused virtual-time checks for slow execution, renewal rejection/exception, cancellation during observation, exact attempt counts, and cleanup failure without false success.

## 2. External services and resource lifetime

- [x] 2.1 Complete/reuse the phase-2 asynchronous process service with bounded output, timeout, real child cancellation, and bounded termination/reader cleanup; test process exit and supported descendant behavior.
- [x] 2.2 Migrate workflow Herdr and Pi/OpenCode/OpenCode V2 lifecycle operations through one shared envelope parser and Schema boundary; retain runtime-specific contract tests and stable agent identity recovery.
- [x] 2.3 Migrate credential prompting and askpass/FIFO acquisition to scoped operations; test cancellation during acquisition, FIFO rendezvous, pending UI response, process exit, and no-UI failure with no retained secrets.
- [x] 2.4 Migrate secure file/assignment/asset I/O behind concrete boundaries without weakening no-follow traversal, atomic publication, permissions, size checks, or capability protections.

## 3. Handler and context migration

- [x] 3.1 Migrate workspace setup/close/cleanup and agent launch/prompt/stop handlers; test transfer of durable resource ownership, survival after successful drain, reused pane protection, and successor adoption.
- [x] 3.2 Migrate artifact, notification, OpenSpec validation, delivery commit/push, and PR handlers; verify idempotency observation, uncertain-result handling, pinned delivery settings, and permanent versus transient failures.
- [x] 3.3 Migrate wiki verification/read/write operations and callers to explicit pinned-root context; delete `withWikiRoot` global environment mutation and test overlapping operations with different roots.
- [x] 3.4 Assert registered handler coverage, delete replaced orchestration/timer/polling implementations, and update the migration inventory for any remaining outer caller bridges.

## 4. Validation and documentation

- [x] 4.1 Run focused runner, adapter, credentials, wiki/source-isolation, and secure-file checks; retain real subprocess, SQLite takeover, and crash-after-success recovery cases alongside virtual-time tests.
- [x] 4.2 Verify observation/attempt exhaustion/operator retry, final lease fencing, and compiled handler launch compatibility; no live agent or external delivery smoke without explicit opt-in.
- [x] 4.3 Update production-backed agent recipes and ownership/failure documentation, then run `bun run type-check`, `bun run lint` with zero diagnostics, and relevant build/smoke checks from `agentic-coding/`.
