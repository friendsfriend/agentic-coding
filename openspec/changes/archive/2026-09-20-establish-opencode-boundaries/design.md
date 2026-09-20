# Design: Establish OpenCode-Style Boundaries

## Context

See `proposal.md` for motivation and scope. Current backend contracts are split between `src/server/protocol.ts`, `src/workflow/contracts.ts`, `src/tui/dash/types.ts`, and `src/tui/otel/model/types.ts`. `BackendClient` is HTTP-only but dashboard compatibility modules still call workflow operations directly. `src/tui/index.tsx` also mixes application composition with dashboard data loading and workflow ownership.

The existing architecture checker already parses TypeScript imports and guards workflow/TUI direction. This change extends that checker rather than creating a second dependency-graph implementation. Existing server ownership, Effect boundaries, route versioning, event replay, cancellation, and keybind-catalog rules remain constraints.

## Goals / Non-Goals

**Goals:**

- Establish one pure, application-owned contract source for server/client/gateway wire shapes.
- Make feature data modules depend on one gateway/client port, with HTTP and in-process implementations interchangeable.
- Keep server and workflow modules independent from TUI presentation, including type-only imports.
- Make dashboard data reactive through a small cache invalidated by typed events, not through feature-owned I/O.
- Preserve server-owned execution coordinators, observational reads, revision checks, event recovery, and existing UI behavior.
- Enforce boundaries with runnable tests and fixtures included in normal lint/verification.

**Non-Goals:**

- No new dashboard feature, workflow transition, route semantics, database schema, or transport protocol version.
- No replacement of Solid/OpenTUI, Effect, the existing `BackendClient`, telemetry stores, or keybind catalogs.
- No generic query library, second event store, speculative package split, or compatibility layer retained after callers migrate.
- No attempt to make every existing `@devenv/types` environment model part of the new dashboard contract surface.

## Decisions

### 1. Use `src/contracts` as application wire-contract owner

Create `agentic-coding/src/contracts/` with `workflow.ts`, `telemetry.ts`, `actions.ts`, `environment.ts`, `integration.ts`, `credential.ts`, and `index.ts`. These modules contain plain structural types and Effect Schemas only. They have no imports from TUI, server, workflow runtime, database adapters, filesystem/process APIs, or `@ui`.

`packages/devenv/types` remains the existing devenv/environment schema package for modules that already use it. It is not added to `packages/ui`; presentation components keep local prop types or receive structural props defined by their component package. This avoids making `@ui` depend on application/domain packages merely to render rows.

**Alternative rejected:** moving all contracts into `packages/devenv/types`. That would couple the application wire surface to an existing environment package and would not remove the current `@ui` domain dependency without a second migration.

### 2. Define schemas once, expose route metadata separately

Contract modules own request/response/event schemas and decoded TypeScript types. `server/protocol.ts` keeps API version constants, route ownership, route/path bounds, and route registration, importing schemas from `contracts` instead of defining parallel shapes. `server/client.ts` decodes each response at its boundary and exposes methods named for application operations, not generic `api.*` escape hatches.

The first contract surface covers workflow list/view/start/action/handoff/repair/preview/question, Git status/diff, wiki reads/render/snapshot, Herdr pane/agent/launch observations, telemetry pages, event envelopes, connection status, and errors. Existing routes retain paths and response semantics; missing route support is added before TUI callers move.

**Alternative rejected:** leaving schemas in `server/protocol.ts` and exporting inferred types from it. That keeps the backend as the type owner and makes in-process gateway consumers depend on transport code.

### 3. Introduce one `DashboardGateway` port behind both transports

Define a narrow gateway interface in the contracts layer. It contains typed selectors/mutations and event subscription methods for dashboard data. It accepts `AbortSignal` where reads can outlive a view and carries revision/action identifiers unchanged to mutation methods.

Implementations:

- `BackendClient` implements the port over authenticated versioned HTTP, decoding all responses with contract schemas.
- `server/gateway/` implements the same operations against server-owned application services and the workflow engine. It receives application dependencies from the composition root; it never imports TUI modules.
- `tui/context/engine-gateway.ts` selects the configured implementation. `tui/data/*` receives the port and does not branch on transport.

Gateway conformance tests run representative read, stale mutation, abort, event, and error cases against both adapters. In-process mode is a composition choice for managed/demo startup, not a second dashboard API.

**Alternative rejected:** making data modules call `BackendClient` directly everywhere. That would solve import direction but preserve two transport modes and make tests depend on HTTP setup.

### 4. Split data by ownership, keep projections pure

Replace `tui/dash/observations.ts` with:

- `tui/data/workflow.ts` — list/view/start/action/handoff/repair/preview/question.
- `tui/data/git.ts` — worktree status and diff observations.
- `tui/data/wiki.ts` — concept reads, render, changes, and snapshots.
- `tui/data/herdr.ts` — pane, agent, launch, and socket observations.
- `tui/data/telemetry.ts` — `TelemetryDb` reads and change notifications.
- `tui/data/index.ts` — thin composition and event invalidation facade.

Data modules own request cancellation, schema-shaped errors, cache invalidation keys, and authoritative refresh. `tui/dash/projections.ts` remains pure and maps contract data to display rows. Views receive selectors and callbacks; they do not fetch, instantiate engines, read repositories, or infer available actions.

The cache is a small Solid-compatible reactive store keyed by repository/workflow/resource. Workflow revision and event resource identifiers invalidate targeted entries. Gaps or unknown event revisions trigger bounded snapshot refresh through the gateway. Telemetry/Herdr changes update observation keys without pretending to commit workflow state.

**Alternative rejected:** reproducing OpenCode's large general-purpose data monolith or adding TanStack Query alongside the existing event model. Both create two authorities for cache invalidation.

### 5. Make composition root own concrete services

`src/tui/index.tsx` constructs the configured gateway/client, data store, local route/draft state, telemetry database, event subscriptions, and root-owned lifecycle resources. `AppShell`/`DashboardRoot` receive providers and callbacks. Feature routes do not create execution coordinators, workflow engines, server lifetimes, or telemetry watchers.

Add `tui/context/client.ts`, `data.ts`, `local.ts`, and `engine-gateway.ts` as small providers. `local.ts` owns filters, drafts, modal/journey state, and route-identity keyed transient values. Server data never shares these maps.

The standalone workflow dashboard and full shell can use the same providers with different composition inputs. Settings reads use the client/data surface; direct workflow imports in `settings/server-config.ts`, OTEL views, dashboard launchers, and tracing helpers are removed or moved behind data adapters.

### 6. Migrate wire types without changing domain ownership

Move `TraceSummaryPage`, `SpanData`, and related OTEL wire records to `contracts/telemetry.ts`. Move dashboard request/response records from `tui/dash/types.ts` and the transport-facing portion of `workflow/contracts.ts` to contracts. Keep engine-only snapshots, command internals, step behavior, and persistence records in `workflow/`.

`workflow/contracts.ts` becomes a small engine-facing surface and may re-export no TUI or transport type. `tui/otel/model` remains an interface-driven receiver/store/view model, importing contract telemetry types only. Tests update imports to contracts rather than adding aliases in old modules.

### 7. Split dashboard presentation after data cutover

Treat `dash/App.tsx` as a route coordinator during migration, then move page-specific rendering into route/view modules for home, workflow list, workflow detail, review, and questions. Move modal state and page-local actions into `dash/state` and keep feature modals props-only. Preserve panel-grid semantics, projections, keybind catalogs, modal stack ownership, and help/footer rendering.

No dashboard component may derive action availability from step or definition identifiers. It renders the action list and revisions delivered by the workflow contract, preserving current server-side authority.

### 8. Enforce boundaries with one architecture test surface

Extend `scripts/workflow-architecture.ts` and its existing tests with:

- TUI forbidden-edge checks for workflow/server internals, allowing only the client/contract/provider composition exceptions explicitly documented in the test.
- Reciprocal server/workflow-to-TUI checks, including type-only imports and re-exports.
- Contracts purity checks rejecting imports outside Effect and other approved pure modules, plus node I/O, database, ambient clock, and `@ui` dependencies.
- `@ui` package dependency checks rejecting `@devenv/types` and application imports.
- Gateway parity checks and stale exception detection.

Fixture tests must fail on the current wrong-direction imports before migration and pass after each phase. `bun run lint` invokes these checks through the existing project script path; `bun run type-check` remains a separate gate.

## Risks / Trade-offs

- **[Large migration touches dashboard, server, workflow, OTEL, and package types]** → Land in dependency order: contracts, client routes, data cutover, gateway, composition, presentation split, then enforcement tightening. Keep each phase type-checkable and delete old barrels immediately after final caller migration.
- **[HTTP and in-process gateway behavior diverges]** → Use one contract decoder and adapter conformance tests for reads, stale revisions, cancellation, event gaps, and errors. No TUI code branches on adapter kind.
- **[Event invalidation leaves stale cached views]** → Include resource and revision in event contracts, invalidate by key, and force authoritative snapshot refresh on unknown/gapped revisions. Never treat cache state as workflow authority.
- **[Moving types creates accidental domain leakage]** → Keep contracts import-free from runtime modules and run the purity scanner. Map application contracts to local `@ui` props at the TUI boundary.
- **[App split changes keyboard or modal behavior]** → Move rendering without changing keybind catalogs or dispatch ownership; retain projection and focused-panel tests before deleting the monolith sections.
- **[Boundary test over-restricts composition code]** → Allow only named composition/client adapter files, document each exception with removal condition, and fail stale exceptions.

## Migration Plan

1. Add `src/contracts` and move OTEL/dashboard wire types with no route behavior change; fix `server/client.ts` first.
2. Move route schemas and event/action envelopes into contracts, extend protocol/client methods for all dashboard reads and mutations, and add decode tests.
3. Create `tui/data/*`; migrate dashboard, OTEL, settings, and launch callers from `observations.ts`, `engine.ts`, and direct workflow imports. Delete compatibility barrels after imports are gone.
4. Add the in-process server gateway and gateway conformance tests. Wire managed/demo mode through it while attached mode uses HTTP.
5. Add TUI contexts and move concrete service/store construction into `tui/index.tsx`; keep lifecycle resources root-owned.
6. Split `dash/App.tsx` into route/view/state modules and make `@ui` props-only without `@devenv/types`.
7. Extend boundary and contracts-purity tests, add negative fixtures for every forbidden edge, and wire them into lint/verification.
8. Run full type-check, lint, tests, and a managed/attached TUI smoke check. Rollback is commit-level: until the final cutover, each phase can be reverted without data migration; no persisted wire or workflow-state format changes.

## Open Questions

None. Physical contract location, gateway shape, migration order, and enforcement exceptions are resolved above; remaining implementation choices must not change those boundaries.
