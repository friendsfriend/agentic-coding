## 1. Prerequisites and service boundaries

- [x] 1.1 Confirm foundation, store migrations, observation/execution separation, and step completion centralization are landed; update the inventory to actual module locations before editing overlapping code.
- [x] 1.2 Define and implement concrete store/configuration/evidence boundaries using the locked Effect APIs; provide production and test Layers without creating services for pure helpers.
- [x] 1.3 Implement scoped SQLite acquisition/close and a non-suspending transaction primitive; test acquisition failure, rollback, close, interruption boundaries, and bounded lock contention.

## 2. Engine and security

- [x] 2.1 Migrate initialization, canonical target resolution, status/list/snapshot reads, and repair/migration previews to Effect; verify absent/old stores remain non-mutating on reads.
- [x] 2.2 Migrate dispatch/start transactions, reducer application, and expected pure-domain rejection mapping; preserve atomic snapshot/event/outbox writes and rejection-audit policy.
- [x] 2.3 Migrate capability and evidence preparation operations; verify artifact size/path/digest/source-binding checks and final transactional reauthorization remain intact.
- [x] 2.4 Migrate claim/renew/liveness and question-expiry operations using one live/test clock, including current-time sampling after writer-lock acquisition.
- [x] 2.5 Separate committed command results from post-commit scheduling/telemetry failures; add a regression check for interruption after commit without duplicate mutation or false rollback reporting.

## 3. Shared startup and callers

- [x] 3.1 Migrate configuration/provenance reads and Schema decoding, target resolution, executable/model preflight, and asynchronous Git preparation while retaining pure profile/routing functions.
- [x] 3.2 Expose shared Effect startup/application operations without imports from CLI composition; reuse a single concrete process boundary and record remaining phase-3 adapter work.
- [x] 3.3 Update affected engine/startup callers and focused tests; inventory temporary outer runtime bridges and prohibit nested runtime execution inside engine services or SQL callbacks.

## 4. Validation and documentation

- [x] 4.1 Run focused runtime, migration, capability/artifact, question, startup, registry-pin, and concurrent-handoff checks with real temporary SQLite where required.
- [x] 4.2 Verify supported historical snapshots/pins and current CLI/view fixtures remain compatible; exercise competing revisions, active sibling generations, lease expiry, and initialization rejection.
- [x] 4.3 Update architecture/playbook examples and inventory, then run `bun run type-check`, `bun run lint` with zero diagnostics, and relevant compiled-binary build/smoke checks from `agentic-coding/`.
