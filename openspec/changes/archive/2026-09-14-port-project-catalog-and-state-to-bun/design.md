## Context

Depends on `expose-unified-bun-backend`. Go app manager currently loads static configuration, overlays SQLite runtime state and derives managed checkout paths. Go services write environment state, action history and dependency leases. Bun workflow and telemetry stores remain separate domains.

## Goals / Non-Goals

**Goals:** One Bun catalog/configuration authority and environment-state writer, compatible schema/history, safe mixed-runtime operation.

**Non-Goals:** A new database layout, moving repositories, converting workflow pins or eliminating all Go in this slice.

## Decisions

1. Port app/library/infrastructure loading and path resolution into `src/server/environment/` with pure projections and explicit filesystem boundaries. Preserve current env/config precedence, managed path layout, static-vs-runtime separation and invalid-config diagnostics. Reuse configured-project API established earlier; do not parse configuration again in the frontend.
2. Use `bun:sqlite` against existing `$DEVENV_HOME/db/state.db`. Translate existing migrations and validate supported/future versions. Do not merge workflow `herdr.db` or telemetry stores, change action IDs, or introduce schema changes for naming consistency. Use SQLite consistent backup and integrity checks before first writer cutover.
3. Bun owns all environment-state writes and schema initialization after cutover. Remaining Go services consume narrow private typed operations corresponding to existing StateStore/Manager methods; no SQL-over-HTTP endpoint. Preserve transaction boundaries as single backend operations where multiple updates must be atomic. Go retains no direct schema-writing/writable DB handle in migrated mode. This bridge has a real second runtime caller and is removed after final port, not generalized into an RPC framework.
4. Avoid startup recursion: Bun initializes state/catalog before starting Go; Go requests its snapshot without calling proxied public routes back into itself. Add instance-authenticated private client, bounded requests and explicit errors. Go config reload delegates to Bun authority and then refreshes dependent immutable registry snapshot.
5. Inventory all writers including build/run targets, script history, action/log events and dependency leases before switching. Retain existing ordering/retention semantics and improve transport cursor stability only without reinterpreting stored events. No shadow mutation or dual writer is permitted.

## Risks / Trade-offs

- Cross-language SQL affinity/null/time drift → native Go database fixtures opened by Bun and round-trip value comparison.
- Private state bridge adds overhead → batch only actual atomic logical operations; measure action-output history ingestion without making command ownership ambiguous.
- Restart during migration corrupts state → migration lock/version reread, consistent backup and unsupported-version fail-closed behavior.
- Config reads mutate runtime state implicitly → inventory existing load-time backfills and preserve them in explicit initialization, not observation.

## Migration Plan

Create compatible read/schema tests; port config and state; implement private Go adapters; stop writers and back up state; atomically select Bun writer and restart both runtimes. Test active-worktree fallback, event/log history, dependency leases and config reload. Rollback stops all writers and uses a verified backup if any schema incompatibility exists; do not downgrade a live DB or start both writer generations.

## Open Questions

No product decision remains. Any previously undocumented migration behavior found in Go must be added to fixtures before its port is approved.
