## 1. Inventory and safety baselines

- [x] 1.1 Capture the current workflow v6 DDL, `PRAGMA user_version`, table/column/index set, and representative v6 operations in disposable fixtures; confirm the current DDL includes every v6 object, including `workflow_migration_diagnostics`.
- [x] 1.2 Inventory all workflow/config/environment/telemetry migration readers, old-format aliases, current-state repair reducers, dependent effects/CLI/contracts, and their callers; distinguish current-format fields and behavior that must remain.

## 2. Workflow store and engine

- [x] 2.1 Replace store upgrade/import and unversioned shape inference with direct v6 creation for a genuinely empty database and a no-write v6-only gate for existing stores; keep `STORE_SCHEMA_VERSION = 6`, the current v6 DDL, all current tables/columns/indexes, and existing version pragmas unchanged.
- [x] 2.2 Remove workflow legacy-row import, migration diagnostics handling/projections, `legacyChangeIds`, migration-required views, old-shape observers and `operator.migrate` preview/reducer/effect/event paths; retain current-format `repair`, `repin`, `resume`, exact pin resolution, and orchestration semantics.
- [x] 2.3 Remove the `workflow migrate` CLI registration, help, command implementation, server/API contracts and dead exports; make unsupported existing store versions surface exactly `unsupported workflow store version N; this build only reads version 6` without modifying the database.
- [x] 2.4 Replace migration-only workflow tests with production-path tests for fresh v6 creation, copied existing v6 opening and use, and non-v6/unversioned/future store refusal with unchanged file/schema/rows/version; retain current repair and orchestration tests.

## 3. Canonical config and TUI preferences

- [x] 3.1 Delete `src/config-migration.ts` and `src/config-command.ts`; remove `config migrate`, migration journal/recovery helpers, old root aliases and TOML location/key fallbacks from `config-root.ts`, CLI/server setup, workflow config loaders, profiles and definition parsers.
- [x] 3.2 Keep current JSON validation, canonical root precedence, current project JSON overlays, secret handling, presets/routes, atomic writes and `DEVENV_HOME`; remove only legacy theme import and migration-only inactive-source Settings strings while preserving `tui.json` and custom theme behavior.
- [x] 3.3 Copy `/tmp/agentic-config-snapshot` into a temporary owned fixture before loading it. With `HOME=<tmp>` and `AGENTIC_CODING_CONFIG_DIR=<tmp>`, verify `loadConfig`, `loadAgentConfig`, `loadCompactionSettings`, `orchestratorLaunchCeiling`, and project catalog against the copied current config; if the snapshot is absent, build an equivalent current-format fixture. Never use the real HOME/config directory.
- [x] 3.4 Replace config migration/root/preferences tests with focused current JSON and `tui.json` load/save tests plus old-format/alias refusal-or-ignore tests that prove no source or canonical file is rewritten; keep credential, layering, preset and current settings tests.

## 4. Environment state and telemetry

- [x] 4.1 Replace environment schema upgrade/backup/recovery with direct current v9 creation for an empty database and a no-write v9 gate for existing databases; preserve the current v9 schema and current state behavior, and remove migration-only helpers.
- [x] 4.2 Add focused environment-state production tests for fresh v9 creation, current v9 open and operations, and old/future version refusal with unchanged schema, rows, backup set and file contents.
- [x] 4.3 Remove telemetry database schema adoption, old `traces.jsonl` source selection, historical event parsing and parser-version-triggered old-index re-ingestion; preserve current SQLite/`telemetry.jsonl` ingestion, query, paging and live-update behavior.

## 5. Contracts, tests, documentation and export cleanup

- [x] 5.1 Remove only old-format workflow/config/environment/telemetry contract aliases and migration-only types/strings; retain fields required by current v6 state, current versioned workflow pins, current repair, and the `migration-verifier` definition/instructions/classifiers.
- [x] 5.2 Delete or split tests/fixtures that exist only for removed behavior; update mixed tests to preserve current-format coverage. Regenerate `src/workflow/embedded.generated.ts` through the package build (never hand-edit it) and update `test/fixtures/workflow-god-module-export-surface.json` plus its export ratchets for removed exports.
- [x] 5.3 Update root README, config/settings inventories, workflow/environment architecture and state-port docs, installation scripts/help, and affected OpenSpec requirements with explicit `REMOVED Requirements` reasons/migration guidance and current-format replacement contracts. Preserve unrelated Effect/code migration history, other-project database migration guidance, migration-verifier material, current API semantics, and atomic rename documentation.
- [x] 5.4 Run focused workflow-store, config-snapshot, preferences, environment-state, telemetry and API contract tests; run Biome lint, type-check, dead-export checks if available, `openspec validate "remove-legacy-migration-logic" --strict`, and `openspec validate --specs --strict`. Do not run the application/server/TUI/CLI against real developer data; the workflow test-verifier owns the full configured repository test suite.
## 6. Scope note: the unversioned `/api/*` surface is current product API

The plan's route tasks (audit `/api/*` callers, move still-used routes to typed
`/api/v1` ownership, update their tests) were **removed from this change**. The
developer confirmed that decision:

- The unversioned `/api/*` surface is the **current** first-party product API.
  It is what this process serves and what the TUI backend client calls; it reads
  no obsolete persisted format. Its `legacy` naming is historical, not a
  compatibility shim.
- The developer task inventory for this change lists the workflow store,
  configuration, environment-state/telemetry/TUI stores and their
  tests/fixtures/docs, and states that the runtime/app/action route modules keep
  reading and writing their current format.
- Renaming the surface to `/api/v1` is therefore an API break with no
  old-format reader removed, and belongs to its own change and decision.

Nothing in this change adds, renames or deletes a route, and no route test was
changed. If route modernization is wanted later, it starts as its own change.
