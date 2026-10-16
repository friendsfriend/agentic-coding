# TUI mouse navigation parity

## Why

The TUI is keyboard-first and today only a handful of components react to the
mouse: the shared `Selectable`/`Card`/`SelectableList` rows pass an
`onMouseUp` to a caller-supplied `onSelect`, `ScrollableList` forwards
`onMouseScroll`, `GenericModal` closes on a backdrop click, and the location
picker, breadcrumb row, workspace sidebar, trace/metric/wiki lists and a few
agent-session rows wire their own handlers. Everything else — the dashboard's
panels and modals, the agent-session page, the Orchestrator page, the
Environments feature, Settings and most of the observability and wiki surfaces —
ignores the pointer entirely, and the handlers that do exist behave differently
(the picker row accepts on click, a destination row only selects, a sidebar row
opens on click).

A developer who reaches for the mouse hits a surface that either does nothing or
does something different from the key that means the same thing. This change
gives every keyboard-reachable surface a consistent, cheap mouse path, defined
once in the shared primitives instead of re-invented per panel.

## What Changes

- **A shared mouse interaction layer** in `@ui` (`packages/ui/src/components/mouse/`)
  owns the semantics: tap = select, tap on the already-selected row = activate
  (same as Enter), tabs/section headers clickable, footer/help key chips
  clickable, panel focus on tap, wheel scrolling of the pane under the pointer,
  backdrop/close-control dismissal where Escape would dismiss, and a rule for
  which modals must stay explicit (unsaved input, secrets, irreversible
  actions). Hit-testing, the drag-vs-tap rule that protects text
  selection/copy, and the double-click window live in one pure, unit-tested
  module; hooks and wrappers apply it, no surface invents its own handler.
- **The layer is applied** to the dashboard panel grid, all dashboard modals,
  the agent-session page, the Orchestrator page, the Environments feature,
  the Settings screens, the observability tabs and the Wiki view — plus the
  shell chrome (sidebar workflow rows, tabs, footer chips, breadcrumbs,
  location picker, destination lists, toasts).
- **Inventory first**: design.md records every TUI screen, panel, modal, list,
  tab and button with its current keyboard actions, its current mouse support
  and the affordance it gains, and the change decides per item.
- **Mouse is additive**: no key binding is removed or changed, no store or
  server behaviour changes, and `STORE_SCHEMA_VERSION` is untouched.
- **Cheap by construction**: no `onMouseMove` handler and no hover state
  anywhere, no polling, one state update per tap (the same update the keyboard
  already performs) and a direct scroll for the wheel.

## Capabilities

### New Capabilities

- `tui-mouse-interaction`: the shared click/wheel/dismiss semantics, the
  drag-vs-tap rule, the per-surface parity requirement (every keyboard action a
  pointer can reach must have a mouse path), the layering/hit-testing rules and
  the surface inventory contract.

### Modified Capabilities

- `tui-shared-primitives`: the mouse layer joins the shared primitives — one
  implementation, one owner, family wrappers re-export rather than fork.
- `hierarchical-tui-navigation`: a tap obeys the same hierarchy and input
  isolation as the keyboard — a modal swallows taps meant for what is below,
  backdrop dismissal matches the Escape ladder, breadcrumbs/picker/destination
  rows navigate like Enter.
- `tui-clipboard-copy`: a pointer drag is never a tap, so selection and copy in
  transcripts, markdown and the diff views keep working.
- `tui-input-responsiveness`: mouse handling stays inside the existing budget —
  no per-move render work, no timers, no extra polling.
- `dashboard-panel-navigation`: clicking a dashboard panel focuses it and
  clicking a panel row selects it, mirroring `J/K/H/L` and `j/k`.
- `centralized-application-settings`: Settings section rows, the bounded numeric
  editor, the agent preset view and its pickers accept the pointer.
- `home-orchestrator`: the Orchestrator page's transcript, prompt input, model
  picker and transcript rows accept the pointer.
- `unified-feature-shell`: the shell chrome (workspace sidebar rows, footer key
  chips, breadcrumbs, location picker, destination lists, toasts) is fully
  pointer-reachable and keeps one owner for click semantics, and the embedded
  Environments feature (tables, detail views, slot/action views, dialogs) gains
  the same pointer path.
- `standalone-workflow-dashboard`: the dashboard's dialogs and the agent-session
  page accept the pointer under the same semantics, with typed-input dialogs
  staying explicit.
- `dashboard-agent-session-view`: the session view's transcript, prompt, block
  rows and picker/filter lists accept the pointer without disturbing selection
  copy or key handling.

## Impact

- New: `packages/ui/src/components/mouse/` (pure semantics + hooks + wrappers),
  exported from the `@ui` barrel; tests under `test/dash/` and `test/ui/`.
- Changed primitives: `Selectable`, `Card`, `SelectableList`, `ScrollableList`,
  `ScrollableContent`, `Panel`, `GenericModal`, `ListViewModal`, `HelpText`,
  `StatusBar`, `ModalTabs`, `Table`, `WorkItemCard`, tag/choice rows in
  `Form`.
- Changed surfaces: `src/tui/dash/**` (App, panels, modals, agent session view),
  `src/tui/orchestrator/OrchestratorView.tsx` (minimal, well separated),
  `src/tui/settings/**`, `src/tui/app/**` + `packages/devenv/cli/src/tui/**`
  (embedded Environments feature), `src/tui/otel/**`, `src/tui/shared/navigation/**`.
- Docs: `src/tui/dash/README.md`, `src/tui/shared/README.md`,
  `docs/settings-inventory.md`-adjacent TUI docs, plus the in-app help text
  that lists keys (mouse parity is stated once, never as per-body cheat text).
- No server, workflow-engine, store-schema or CLI behaviour change; no new
  dependency; `src/agent-host/orchestrator.ts` and the env-setup flow are not
  touched.
