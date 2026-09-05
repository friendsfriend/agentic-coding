## Context

`openStore()` currently creates tables, probes columns and DDL, and repairs parent/child table shapes on every connection. `view.status()` and `view.list()` can import legacy rows. The code supports databases predating issued_revision, allowed_outcomes, workflow-ID identity, and repaired foreign-key targets.

## Goals / Non-Goals

**Goals:** deterministic schema versions, safe multi-process initialization, lightweight observational connections, and preserved legacy evidence.

**Non-goals:** deleting old workflow sources, moving the database, adding a migration package, or automatically downgrading schemas.

## Decisions

### Ordered native SQLite migrations

Use PRAGMA user_version and a small ordered list of migration functions. Separate explicit `initializeStore` from read/write connection opening. For user_version=0, inspect supported historical schemas once inside initialization to adopt a baseline safely; do not assume every unversioned store is empty or identical.

Acquire the migration writer lock before deciding which version transitions to run, then reread user_version. Each migration atomically applies its data/DDL changes and advances its version. For rebuilds requiring foreign_keys=OFF, set that connection pragma outside the transaction, then acquire/recheck under the lock, run the rebuild, perform foreign_key_check before commit, and restore enforcement in finally. Avoid SELECT * when historical column order may differ.

A newer unsupported version fails closed without DDL or data changes. Schema-check failure closes the connection instead of leaking a partially initialized handle.

### Reads do not initialize

Read-only connections inspect supported version and return data or an actionable migration-required diagnostic. They neither create a missing database nor run schema repair. Existing status/list compatibility projections can present diagnostics without importing workflow rows.

Expose an explicit application-level initialization/import function; mutating engine entry points invoke that same idempotent initialization before opening their command transaction. Existing operator repair access can initialize/import its target through this boundary; no new migration CLI verb is required. Keep initialization transactions separate from workflow command transactions and document that valid migration can persist even when a later requested command is rejected.

### Legacy workflow import stays separate

Reuse `runtime/migration.ts` for domain mapping after schema initialization. Preserve source rows/files, conflict diagnostics, fresh-run issuance, and migration events. Import only in explicit migration or mutating workflow access, never list/status. Concurrent imports remain idempotent under the canonical writer transaction. Moving when import happens must not weaken source validation or choose latest-wins on conflicting mirrors.

## Risks / Trade-offs

- Unversioned databases have multiple shapes → fixture every supported shape and reject unknown layouts without destructive guesses.
- Foreign-key rebuilds can lose data or indexes → explicit columns, row/event/outbox equivalence checks, index checks, and foreign_key_check before version advancement.
- Old binaries can still write old assumptions → require writer shutdown for upgrade; mixed old/new writers are unsupported.

## Migration Plan

Create backups with SQLite's consistent backup mechanism before upgrading persistent stores. Initialize one supported historical fixture at a time, then test two independent initializing processes and interruption between migration steps. A failed step rolls back its DDL/data/version; restart continues from the last committed version. Rollback to an older binary requires a verified pre-upgrade backup unless that binary explicitly supports the new version. No automatic down migrations.
