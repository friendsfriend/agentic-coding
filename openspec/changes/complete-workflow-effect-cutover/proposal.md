## Why

Agent leverage depends on one finished programming model, not indefinitely maintained Effect and legacy paths. Complete the migration at CLI/dashboard runtime boundaries, remove transitional orchestration, and verify that documented patterns produce correct agent-authored changes.

## What Changes

- Give CLI invocation and dashboard application lifetimes explicit Effect runtime/resource ownership; reuse one application service composition and the existing explicit execution coordinator.
- Migrate all remaining workflow-facing callers, including question waits, wiki/configuration tools, project discovery, navigation I/O, and workflow telemetry.
- Keep Solid/OpenTUI components and pure projections in their native model; convert Effect results at narrow UI/framework boundaries with cancellation and late-result protection.
- Remove migration-only engine/handler/parser/runtime bridges and obsolete bespoke async infrastructure; guard against their reintroduction using the existing source graph checker.
- Preserve external CLI/JSON, telemetry correlation, durable store/pins, and observational reads; document coordinated runner deployment and rollback compatibility.
- Finish production-backed agent recipes and repeat the two baseline tasks, reporting corrections/regressions rather than asserting automatic productivity gains.
- **BREAKING:** Remove deprecated internal synchronous/Promise workflow orchestration APIs. Native third-party adapters and outer framework bridges remain explicitly supported boundaries.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-engine-runtime`: Lifecycle-owned composition, complete migration coverage, and guarded runtime boundaries.
- `dashboard-engine-integration`: Effect application integration with cancellation-safe UI updates and unchanged authority.
- `herdr-workflow-testability`: Final cutover and agent-recipe verification gates.

## Impact

- Depends on all three preceding Effect proposals, plus landed `split-dashboard-responsibilities` and `enforce-source-layer-boundaries`; the observation/execution prerequisite remains authoritative.
- Code: workflow CLI/application composition, `src/cli.ts`, workflow-facing TUI/dashboard/wiki/configuration modules, telemetry/export services, remaining shared-client callers, architecture checks, docs, and tests.
- Uses existing Bun test/build and Biome commands. Generated workflow assets are regenerated only through `bun run build` when their sources change.
- No UI framework replacement, new permanent daemon, or workflow protocol/storage migration.

## Non-goals

No Effect rewrite of unrelated TUI features or standalone tooling, no global Effect state store for Solid, no blanket ban on plain pure TypeScript/native adapters, and no permanent compatibility mode between two workflow engines.
