## 1. Contract Layer

- [x] 1.1 Create `agentic-coding/src/contracts/{workflow,telemetry,actions,environment,integration,credential,index}.ts` with pure types/schemas and verify a contracts import scan finds no TUI, server, workflow-runtime, database, filesystem, process, or network imports.
- [x] 1.2 Move transport-facing workflow view, action, question, handoff, repair, start, and observation records from `workflow/contracts.ts` and `tui/dash/types.ts` into contracts, then verify workflow and dashboard type-check without compatibility aliases.
- [x] 1.3 Move `TraceSummaryPage`, `SpanData`, and related OTEL wire records from `tui/otel/model/types.ts` into `contracts/telemetry.ts`, update OTEL stores/views/tests, and verify `bun test test/otel test/app` passes.
- [x] 1.4 Define bounded dashboard event, connection, error, Git, wiki, Herdr, telemetry, environment, and integration schemas in contracts and verify malformed payload tests fail with structured decode errors.
- [x] 1.5 Export one contract index with no runtime side effects and verify all consumers import shared wire shapes from `src/contracts` rather than TUI modules.

## 2. Server Contract and Ownership Cutover

- [x] 2.1 Move request/response schemas out of `server/protocol.ts` into contracts while retaining API version, route ownership, bounds, and route registration in protocol; verify existing protocol tests pass.
- [x] 2.2 Extend versioned protocol routes for workflow reads/mutations, Git, wiki, Herdr observations, telemetry pages, and event subscriptions; verify every route has an ownership entry and decoded request schema.
- [x] 2.3 Make `server/client.ts` decode every response with contract schemas and remove imports from `tui/otel/model/types.ts` and transport-facing workflow contracts; verify client tests cover invalid response payloads.
- [x] 2.4 Move filesystem, Git, wiki, observation, and Herdr I/O from `tui/dash/observations.ts` into server handlers/actions without changing read-only semantics; verify repeated read tests show no store migration, lease claim, or external launch.
- [x] 2.5 Move Herdr socket subscription and telemetry event publication behind `server/events.ts` and contract event envelopes; verify reconnect, replay-gap, and slow-client tests pass.
- [x] 2.6 Keep server handlers dependent only on workflow/application/contracts modules and verify the source-boundary test rejects no server-to-TUI edge.

## 3. Unified Gateway

- [x] 3.1 Define `DashboardGateway` in the contract layer with typed selectors, mutations, cancellation, connection state, and event subscription methods; verify both adapter stubs satisfy the interface.
- [x] 3.2 Adapt `BackendClient` to implement `DashboardGateway` while preserving authenticated headers, route versioning, bounded payloads, and stale revision errors; verify HTTP gateway tests pass.
- [x] 3.3 Add `server/gateway/` in-process adapter backed by server application services and the existing execution coordinator; verify it never imports `src/tui`.
- [x] 3.4 Route in-process workflow action/start/repair/question/handoff calls through server-owned application boundaries and preserve displayed action IDs/revisions; verify stale actions fail without mutation.
- [x] 3.5 Add in-process adapters for Git, wiki, Herdr, telemetry, and event reads using the same contract shapes; verify observation calls remain non-mutating.
- [x] 3.6 Add gateway conformance tests running representative reads, mutations, aborts, event gaps, and structured errors against HTTP and in-process adapters; verify both result sets match.

## 4. Dashboard Data Layer

- [x] 4.1 Add `tui/data/workflow.ts` for list/get/start/action/handoff/repair/preview/question through `DashboardGateway`; verify no import reaches workflow, server internals, filesystem, Git, or Herdr modules.
- [x] 4.2 Add `tui/data/git.ts` and `tui/data/wiki.ts` for status/diff and concept/render/snapshot reads; verify selectors expose only contract data and callbacks.
- [x] 4.3 Add `tui/data/herdr.ts` and `tui/data/telemetry.ts` for observation and telemetry-db access; verify on-change callbacks invalidate data without changing workflow state.
- [x] 4.4 Add `tui/data/index.ts` with a small keyed reactive cache, request cancellation, revision-aware invalidation, and authoritative refresh on event gaps; verify cache tests reject late results after selection changes.
- [x] 4.5 Migrate dashboard, settings, OTEL, launch, tracing, and wiki callers from `dash/observations.ts` to data selectors and callbacks; verify `rg` finds no production imports of `dash/observations.ts`.
- [x] 4.6 Remove `dash/engine.ts`, `dash/types.ts`, and observation compatibility exports after callers migrate; verify no production or test import references remain.
- [x] 4.7 Verify projections remain pure and action availability comes only from the latest workflow view by running dashboard projection/action tests.

## 5. TUI Context and Composition

- [x] 5.1 Add `tui/context/client.ts` for configured backend client and connection state; verify attached and managed startup expose the same client-facing contract.
- [x] 5.2 Add `tui/context/data.ts` and `tui/context/local.ts` for server-data selectors versus route-identity-keyed filters, drafts, modal state, and journey state; verify unmount does not retain unrelated local state.
- [x] 5.3 Add `tui/context/engine-gateway.ts` to select HTTP or in-process adapter without exposing transport choice to data modules; verify both modes render through one provider surface.
- [x] 5.4 Move concrete client, data store, telemetry stores, event subscriptions, and root-owned lifecycle construction into `tui/index.tsx`; verify feature mount/unmount does not create execution coordinators or backend lifetimes.
- [x] 5.5 Update `AppShell` and `DashboardRoot` to receive providers and callbacks rather than importing server/workflow internals; verify full shell and standalone dashboard tests pass.
- [x] 5.6 Remove remaining direct workflow/server access from settings, OTEL views, dashboard launch/tracing, and feature components; verify the TUI import-boundary test reports no forbidden edge except documented composition adapters.

## 6. Dashboard Presentation Split

- [x] 6.1 Extract home, workflow-list, workflow-detail, review, and questions route/view modules from `tui/dash/App.tsx` while keeping route identity and existing feature reachability; verify route tests cover every existing destination.
- [x] 6.2 Extract page-local state and modal actions into `tui/dash/state` and keep feature modals props-in/callbacks-out; verify modal stack and focus tests preserve open-order Escape behavior.
- [x] 6.3 Preserve `dash/projections.ts`, panel-grid movement, scroll behavior, and dashboard keybind catalogs during extraction; verify focused-panel and `?` help/footer tests pass.
- [x] 6.4 Remove dashboard data-fetching, engine construction, repository access, and action derivation from views; verify a static view scan finds only contracts, `@ui`, OpenTUI/Solid, and provider imports.
- [x] 6.5 Delete obsolete sections from `dash/App.tsx` after route migration and verify the file is a thin route/composition coordinator rather than an I/O monolith.

## 7. Presentational Package Cleanup

- [x] 7.1 Remove `@devenv/types` from `packages/ui/package.json` and workspace usage, replacing domain-shaped imports with local presentational props or TUI boundary mapping; verify package installation and package tests pass.
- [x] 7.2 Ensure `packages/ui` imports no `src`, server, workflow, contracts, or devenv-domain modules; verify its package dependency/import scan passes.
- [x] 7.3 Keep component APIs props-in/callbacks-out and verify UI tests cover structural props without requiring backend schemas or runtime services.

## 8. Boundary Enforcement

- [x] 8.1 Extend `scripts/workflow-architecture.ts` to classify contracts and enforce TUI, server/workflow, and `@ui` dependency direction including type-only imports, re-exports, literal dynamic imports, and requires; verify existing architecture tests remain green.
- [x] 8.2 Add negative fixtures for TUI-to-workflow/server internals, server/workflow-to-TUI types, contracts-to-I/O, and UI-to-domain imports; verify each fixture fails with an actionable dependency path.
- [x] 8.3 Add contracts-purity and package-import tests with explicit named exceptions and stale-exception checks; verify removing an excepted edge fails until its exception is deleted.
- [x] 8.4 Wire boundary and purity tests into `bun run lint` without adding ESLint, Prettier, or a second parser; verify `bun run lint` executes them with zero diagnostics.
- [x] 8.5 Add a repository scan asserting every dashboard read/mutation uses the gateway/data surface and verify no `client.api.*` or direct observation bypass remains.

## 9. Verification and Cutover

- [x] 9.1 Update all affected unit, integration, fixture, and import paths and verify `bun run type-check` passes.
- [x] 9.2 Run dashboard, OTEL, server, workflow, architecture, gateway, and package UI tests and verify no behavior regressions in observational reads, stale actions, event replay, or telemetry rendering.
- [x] 9.3 Run `bun run lint` and `bun run format` from `agentic-coding/`, review import ordering, and verify generated workflow files were not hand-edited.
- [x] 9.4 Exercise managed/in-process, attached/HTTP, standalone dashboard, and `--json` modes and verify all use the same typed data surface and preserve root-owned execution/telemetry lifetimes.
- [x] 9.5 Review changed imports and delete remaining compatibility shims, dead dependencies, and unused boundary exceptions; verify `git grep` finds only intentional contract/gateway exceptions.
