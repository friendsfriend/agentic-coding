## 1. Compatibility fixtures

- [ ] 1.1 Confirm expose-unified-bun-backend is implemented and inventory every Go config/state writer.
- [ ] 1.2 Capture Go-created SQLite fixtures for each supported migration version and existing history/lease/run-target data.
- [ ] 1.3 Capture config/home/env precedence, app/library/infrastructure parsing and worktree fallback fixtures.

## 2. Bun catalog and state

- [ ] 2.1 Port config validation/loading and canonical project projection behind unchanged catalog contracts.
- [ ] 2.2 Port managed repository/active-checkout resolution and explicit initialization backfills with no runtime fields in config files.
- [ ] 2.3 Port schema/version migration to bun:sqlite with lock/version reread, future-version rejection and backup/integrity checks.
- [ ] 2.4 Port app branch/worktree/run-target state operations and transactional behavior.
- [ ] 2.5 Port script argument history and action/output history preserving ordering, retention and cursor semantics.
- [ ] 2.6 Port dependency lease persistence and test interrupted/repeated logical operations.

## 3. Mixed-runtime sole-writer cutover

- [ ] 3.1 Define bounded private StateStore/Manager operations preserving required transaction boundaries without arbitrary SQL.
- [ ] 3.2 Implement Go private state/catalog client and replace direct writable DB/config ownership in migrated mode.
- [ ] 3.3 Order startup to initialize Bun state/catalog before Go and test against recursive proxy/deadlock paths.
- [ ] 3.4 Quiesce old writers, take consistent backup, switch ownership and test Go action/history writes through Bun exactly once.
- [ ] 3.5 Test invalid config reload, interrupted migration, future schema and rollback preconditions.

## 4. Acceptance

- [ ] 4.1 Compare Go-created fixtures and Bun read/write results including null/time/ordering edge cases.
- [ ] 4.2 Verify workflow and telemetry stores/pins remain untouched and no second environment writer remains.
- [ ] 4.3 Run combined verification and catalog/history/action TUI smoke tests; update bridge removal and route ownership inventory.
