## 1. Capture supported stores

- [ ] 1.1 Inventory existing DDL variants and add compact fixtures for empty, each supported unversioned schema, current schema, and unsupported future versions.
- [ ] 1.2 Record row/event/run/outbox identity, capability, index, and foreign-key baselines for every fixture; preserve legacy source files/rows.
- [ ] 1.3 Add tests proving read-only opens of old/missing stores do not initialize or import them.

## 2. Implement versioned initialization

- [ ] 2.1 Separate explicit initialization from ordinary connection opening and add ordered migrations tracked by PRAGMA user_version.
- [ ] 2.2 Detect supported user_version=0 layouts once during initialization, rejecting unknown nonempty layouts rather than guessing.
- [ ] 2.3 Acquire migration ownership and reread version before applying each transition; atomically commit DDL/data/version and close handles on failure.
- [ ] 2.4 Preserve explicit column mappings and indexes through table rebuilds; enforce foreign_key_check before commit and restore foreign-key enforcement in finally.
- [ ] 2.5 Route mutating engine/repair access through initialization before command transactions while making observational connections return absent/migration-required diagnostics.

## 3. Separate legacy domain import

- [ ] 3.1 Move legacy import triggering from status/list into explicit initialization/import or mutating access, reusing existing validated mapping and diagnostic logic.
- [ ] 3.2 Preserve single canonical import, migration event, fresh-run issuance, conflict rejection, and legacy-source retention under concurrent callers.
- [ ] 3.3 Test two independent initializing/importing processes, interruption before and after migration commits, unknown schemas, failed foreign-key checks, and restart recovery.

## 4. Validate and document

- [ ] 4.1 Run affected workflow-migration, workflow-runtime, workflow-cli, workflow-dashboard, workflow-question, and workflow-e2e tests; verify current reads do not execute historical DDL probes.
- [ ] 4.2 Document explicit initialization versus observation, supported versions, consistent backup, writer shutdown, independent migration commits, and rollback limitations.
- [ ] 4.3 From agentic-coding/, run bun run type-check, bun run lint with zero diagnostics, and bun run build.
- [ ] 4.4 Run openspec validate version-workflow-store-migrations --strict and review data-preservation checks before touching persistent user stores.
