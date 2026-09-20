# Establish OpenCode-Style Boundaries

## Why

The project already has a typed Bun backend, Effect workflow engine, OpenTUI shell, and presentational package, but their boundaries are not yet authoritative. Dashboard code still reaches into workflow and server internals, wire types are owned by TUI modules, and in-process versus HTTP execution has no single client-facing port. This makes transport changes risky, preserves large I/O monoliths, and lets forbidden imports regress.

## What Changes

- Introduce a UI-free contracts layer for workflow, telemetry, action, environment, integration, credential, project-catalog, and event wire shapes.
- Make `BackendClient` the only dashboard-facing data and mutation surface; move workflow, Git, wiki, Herdr, and observation reads behind typed server routes and client adapters.
- Move OTEL wire types out of `src/tui/otel/model` and remove server-to-TUI type imports.
- Split `tui/dash/observations.ts` into domain-focused data modules and remove dashboard engine/type compatibility barrels.
- Add one gateway port with HTTP and in-process adapters so dashboard data code does not know which transport is active.
- Add client, cached data, local UI state, and gateway contexts at the TUI composition root; keep feature components props-in and callbacks-out.
- Split dashboard routing/views/state out of `dash/App.tsx` without changing existing feature reachability, keybind catalogs, projections, or server-owned execution lifetimes.
- Remove the `@ui` dependency on `@devenv/types`; shared presentation props move to contracts or remain local to components.
- Add repo-wide import-boundary and contracts-purity tests, and make them part of `bun run lint`/CI.
- Preserve existing workflow, backend API, shell, telemetry, and observational-read behavior; this change changes ownership and enforcement, not user-visible workflow semantics.

## Capabilities

### New Capabilities

None. This is a structural refactor and enforcement change; no new user-facing or wire-level behavior is introduced.

### Modified Capabilities

None. Existing capabilities already define typed backend ownership, dashboard engine integration, feature-shell ownership, and source-layer direction. This change makes those requirements enforceable in the source layout and removes implementation paths that violate them.

## Impact

- `agentic-coding/src/contracts/` or the existing `packages/devenv/types` schema package becomes the shared wire/type owner.
- `agentic-coding/src/server/protocol.ts`, `client.ts`, handlers, events, and a new gateway adapter surface own decoded backend contracts.
- `agentic-coding/src/tui/dash/`, `src/tui/otel/`, `src/tui/context/`, and `src/tui/index.tsx` change ownership and composition only.
- `agentic-coding/packages/ui` loses its domain-type dependency.
- Existing dashboard and OTEL tests need import updates; architecture tests gain forbidden-edge and contracts-purity fixtures.
- No database migration, transport breaking change, workflow-state change, or new runtime dependency is planned.
