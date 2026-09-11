## Why

Configured projects and environment state underpin every subsequent Go service port. A Bun owner for configuration and persistence removes duplicated discovery logic while preserving current on-disk data and mixed-runtime compatibility.

## What Changes

- Port app/library/infrastructure configuration loading and project catalog projection to TypeScript.
- Port environment SQLite state and history access using existing schema/data semantics.
- Make Bun the sole environment-state schema/writer authority; adapt remaining Go services through a bounded private state/catalog client.
- Preserve runtime/config separation, worktree path resolution, history ordering and lease persistence.
- Verify upgrades and rollback using consistent backups and cross-runtime fixtures.

## Capabilities

### New Capabilities

- `bun-environment-state`: Bun-owned configuration/catalog and compatible environment persistence during staged runtime migration.

### Modified Capabilities

None; configured catalog behavior introduced by the predecessor remains unchanged.

## Impact

Depends on `expose-unified-bun-backend`. Ports imported `server/pkg/app/manager.go`, `pkg/state/store.go` and related config/home resolvers into backend modules. Introduces a temporary private Go-to-Bun state bridge with removal in the final cleanup change. Does not combine workflow, environment and telemetry databases.
