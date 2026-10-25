# Tasks

## Approved verifier follow-up scope

The existing eleven completion records below are preserved. Decisions `approve-bounded-session-connection-contract` and `approve-bounded-session-hot-path-hardening` add bounded watch-state safety and session presentation efficiency coverage to tasks 4.2 and 5.1, with the finishing gates in 5.2. Verify initial connecting versus post-frame stale state, paused controls and draft-preserving recovery; lazy compaction measurements and shared gap searches; immutable-source metadata cache reuse/invalidation; and projection-sized markdown retention. These follow-ups do not change host protocol, session command semantics, or workflow lifecycle.

## 1. Agent run projection

- [x] 1.1 Add a pure agent-sidebar projection over workflow overview `state.runs`, matching the dashboard's latest-run-per-role rule and excluding `git`/`dashboard` utility roles; define Active as latest `pending`/`working` and All as latest runs of any status, with stable workflow-target/workflow/run identity, deterministic ordering, optional metadata, and no invented elapsed metric. Verify with focused tests for both filters, source scope, latest-per-role selection, optional fields, ordering, and stable identity in `test/otel/agentSidebarModel.test.ts`.

- [x] 1.2 Cover selection reconciliation in the pure model: retain selection across status/metadata refreshes, remember a filtered-out identity for restoration, and fall back safely only when the source removes it. Verify refresh/filter/removal cases in `test/otel/agentSidebarModel.test.ts`.

## 2. Agent sidebar presentation

- [x] 2.1 Implement `AgentSidebar` using the existing shared panel, selectable-list, theme, clipping, and tap primitives; add Active/All controls, selected/status cues, compact and expanded rows, keyboard activation, pointer selection/activation, and list scrolling. Verify rendering, filtering, keyboard/pointer parity, and wheel behavior in `test/otel/agentSidebar.test.tsx`.

- [x] 2.2 Implement loading, successful-empty, and stale/disconnected presentation plus responsive compact/expanded width calculations. Keep last-good rows visible on refresh failure and omit unavailable run metadata. Verify all states and width boundaries in the focused model/component tests at ordinary and narrow terminal sizes.

## 3. Unified shell integration and key ownership

- [x] 3.1 Mount the agent panel at the right edge on workflow-enabled shell pages and compose it with the workspace panel on either configured side; adapt both widths before the page body overlaps or becomes unusable. Verify both workspace-side arrangements and narrow-terminal composition in `test/otel/agentSidebar.test.tsx` or a focused shell-renderer test.

- [x] 3.2 Add agent-panel focus to shell panel ownership, preserving the previous shell focus for the Ctrl+A return path and parking underlying page/workflow input while the agent panel is focused. Route Ctrl+A only when the shell owns input; preserve modal and text-input ownership and existing workspace Ctrl+S/Ctrl+H/Ctrl+L behavior. Verify global focus, return focus, modal/input precedence, and unchanged workspace navigation in `test/otel/agentSidebarShell.test.tsx` and `test/otel/workspaceSidebar.test.tsx`.

- [x] 3.3 Add agent-panel bindings and compact footer labels to the owning keybind catalogs, mark row navigation standard, and ensure the shared help modal describes the focused panel. Verify footer and `?` help projections in `test/otel/keybinds.test.ts` and the shell keybind integration test.

## 4. Exact workflow-run navigation

- [x] 4.1 Carry the selected workflow target, workflow id, and run id through the workflow route or an equivalent one-shot navigation request; after the workflow dashboard resolves that run, open its exact recorded host/conversation session and consume the request once. Verify direct opening of the selected session from a non-workflow shell page in `test/dash/panelNavigation.test.tsx` or a focused agent-navigation route test.

- [x] 4.2 Handle a missing or stale session handle by leaving the workflow dashboard focused on the exact selected run, without opening another role's session. Verify fallback identity, stale/unavailable handling, and no reopen after closing the session in the focused dashboard navigation test.

## 5. Integration verification

- [x] 5.1 Run the focused agent-sidebar model, component, shell-focus, keybind, and exact-session navigation tests. When an interactive TUI is available, manually verify the right-hand panel on multiple pages, both workspace-side settings, Active/All, compact/expanded sizing, Ctrl+A ownership, scrolling/selection, footer, and `?` help; record any unavailable manual check.

- [x] 5.2 From `agentic-coding/`, run `bun run lint` and `bun run type-check`; resolve diagnostics from this change. Do not run or prescribe the complete repository test suite here; the workflow-owned test-verifier handles it.
