## Why

Every store open performs schema discovery and migration checks, while status/list can import legacy workflows. Structural writes are therefore hidden inside reads, and concurrent processes can decide to migrate from observations made before acquiring the migration lock.

## What Changes

- Replace per-open schema inference with ordered migrations tracked by SQLite user_version.
- Recheck version under the migration lock and preserve transactional recovery and foreign-key integrity.
- Separate schema initialization from connection opening and legacy workflow import.
- **BREAKING:** Read-only access to old stores reports migration-required instead of migrating; explicit initialization or a mutating engine entry point performs supported automatic migration/import.
- Add concurrent-open, interrupted-migration, unsupported-version, and legacy-source preservation tests.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-state-runtime`: Versioned store initialization and legacy import outside observational reads.

## Impact

- Priority: medium; architecture finding 6. No prerequisite changes.
- Code: `agentic-coding/src/workflow/runtime/store.ts`, `runtime/migration.ts`, `runtime/view.ts`, and engine/CLI initialization paths.
- Preserve canonical store location, workflow IDs, events, outbox identities, capability hashes, and historical definition digests.
- Enables `separate-workflow-observation-execution`; no ownership of effect or question scheduling here.

## Non-goals

No migration library, store relocation, deletion of legacy evidence, support for running old and new schema writers simultaneously, or replacement of SQLite.
