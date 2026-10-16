## Why

The application still upgrades/imports obsolete workflow, configuration, environment and telemetry formats, and retains compatibility readers and commands that can rewrite or interpret historical state. Removing those paths reduces unsafe implicit data mutation and dead code while preserving the formats the product currently writes and the behavior of current workflows.

## What Changes

- **BREAKING**: Accept only workflow store schema v6; refuse every other version without mutation using `unsupported workflow store version N; this build only reads version 6`. Preserve the v6 schema, table/column set and version pragma exactly.
- Remove workflow legacy-row import, schema upgrades, `workflow migrate`, and migration-only event/diagnostic/contracts. Retain repair operations that operate on current-format workflow state, exact current-version pin validation, and the migration-verifier role.
- **BREAKING**: Remove `config migrate` and legacy config paths/aliases/readers. Load the current unified JSON config and `tui.json` formats only; reject or ignore obsolete/unknown formats without rewriting them.
- Stop environment-state schema upgrades and historical telemetry/config-file ingestion. Initialize new environment stores directly in the current format; reject or ignore unknown/old formats without rewriting them.
- Leave the unversioned `/api/*` route and event-stream surface exactly as it is: it is the current first-party product API (it reads no obsolete persisted format), so no route is renamed, removed or aliased. A later change may take up an `/api/v1` modernization on its own decision.
- Remove migration-only tests, fixtures, docs, exports, generated-source inputs, export-surface ratchets and obsolete OpenSpec requirements; add current-format and no-mutation refusal coverage.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-state-runtime`: v6-only workflow store open; no legacy imports or schema upgrades.
- `workflow-engine-runtime`: remove migration command/effects and migration-required projections while preserving current engine semantics and repair.
- `workflow-definition-registry`: remove semantic migration; retain exact v6 definition pins and the versioned pin resolution required by current-format workflows.
- `workflow-session-telemetry`: remove legacy migration events.
- `unified-json-configuration`: current JSON-only configuration resolution; no legacy locations, conversion or fallback.
- `unified-ui-preferences`: current `tui.json` only; no legacy theme import.
- `bun-environment-state`: current-schema-only environment state open; no historical upgrades.
- `trace-tree-view`: current telemetry formats only; no historical trace-source/event compatibility.
- `single-bun-application`: preserve current product behavior without historical persisted-format support, including the current unversioned `/api/*` product surface.
- `agent-runtime-routing`, `dashboard-engine-integration`, `no-openspec-workflow`, `direct-apply-workflow`, and `dashboard-user-request`: remove only historical workflow-shape fallbacks and retain current-format routing, dashboard and request behavior.
- `agent-configuration-presets` and `scripts`: remove configuration hard-break conversion/legacy-source requirements while keeping current presets and canonical installation behavior.
- `herdr-workflow-testability`: replace legacy migration coverage with current-format opening and unsupported-version no-mutation checks.

## Impact

The main code surface is `agentic-coding/src/workflow/runtime/{store,migration,view,engine,kernel,services,orchestrator-launches}.ts`, workflow reducers/effects/contracts/CLI; config root/effects/profiles/commands/server/TUI settings and preferences; environment state, telemetry DB/parser/trace store, runtime/action route modules; and their tests, scripts, docs, export fixtures and OpenSpec specs. No route is added, renamed or deleted by this change. Validation must use temporary HOME/config roots and a copied sanitized current config fixture, never the developer's live store or config directory. Main risks are accidental change to the v6 schema/current reads, silent mutation of rejected stores/configs, and deleting current-format repair/pin behavior; focused tests must cover each boundary.
