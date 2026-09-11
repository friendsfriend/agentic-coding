## Context

Depends on `unify-terminal-ui-primitives`. Current roots each own renderer setup, routing and input. devenv has layered keymaps and stacks but synchronizes legacy modal booleans; agentic-coding observability still has raw keypress routing. Workflow application and telemetry watchers must not stop when switching feature tabs.

## Goals / Non-Goals

**Goals:** One renderer, feature-tab shell, discoverable command catalog, modal ownership and complete feature access.

**Non-Goals:** Go porting, changing workflow state/pins, project-discovery cutover or replacing Herdr/tmux.

## Decisions

1. Add `src/tui/app/` for shell composition. Borrow devenv layout/navigation structure rather than mounting either existing root App inside the other. Top-level tabs are Environments, Workflows, Observability and Wiki; environment app/library/infrastructure/script/Kubernetes and observability traces/metrics/logs/topology remain sub-tabs. Providers, issues, CRs, CI, agent utilities and all workflow review/config screens remain reachable.
2. Store typed route identity plus required resource IDs; preserve a view stack per feature with a shared active feature. Cross-feature navigation records origin so back returns to the originating resource. Do not store selected data solely in mutable global indices. Preserve drafts/search/selection when a feature is hidden, and release feature subscriptions when intentionally disposed.
3. A single shell modal stack is authoritative. Opening a dialog pushes a route; top route owns mouse/key input, close reveals the previous route and restores focus. Legacy boolean synchronization is temporary per migrated caller, not a permanent second authority. Instance identity distinguishes repeated dialog kinds. Nested help is a stack entry and literal `?` in text entry is protected.
4. One OpenTUI keymap registers feature-scoped commands and metadata, including `short`, `standard`, category/context and focused panel. Footer/help are projections of those registrations. Remove raw renderer key dispatch and manually maintained help catalogs once migrated. Normalize shifted letters centrally and display J/K/H/L, not Shift+J variants. Preserve workflow 2D grid; environment cyclic focus remains where appropriate. Tab/Shift+Tab navigate feature tabs, not workflow panels; sub-tab commands are separately scoped and documented in the catalog.
5. Move `RepositoryExecutionCoordinator` and application disposal ownership into a backend-facing application module owned by the shell lifetime. Move receiver/store/watch/prune scheduling out of `otel/app/App.tsx` into root-owned telemetry services. Hidden views subscribe to read models only. This is lifecycle extraction, not a new execution engine or network API.
6. Keep environment action definitions and workflow availableActions authoritative in their existing engines. Shared presentation cannot infer retry, completion or action availability by matching role/step labels.

## Risks / Trade-offs

- Dual key handlers trigger duplicate mutations → conflict/dispatch tests and remove old listener registrations before enabling a migrated feature.
- Unmount loses draft or stops engine → separate view ownership from service ownership; test tab switching during active drain and review.
- New header/sub-tabs consume terminal height → shared chrome measurements and renderer tests at narrow/short dimensions.
- External terminal utilities block the Bun event loop → preserve current behavior at this stage; backend-process isolation is delivered by `expose-unified-bun-backend`.

## Migration Plan

Extract root-owned services; build shell with environment content; add workflow, observability and wiki contents; migrate modal and keymap callers incrementally; remove both old root render paths. Compatibility CLI entrypoints choose initial routes in the same shell. Run every feature-inventory journey before marking complete. Rollback reverts composition without database migration; do not run two shells against the same ownership scope during testing.

## Open Questions

No blocking product choices. Default initial tab is Environments; workflow home/dash aliases explicitly choose Workflows.
