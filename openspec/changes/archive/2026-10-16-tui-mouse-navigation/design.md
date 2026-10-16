# Design — TUI mouse navigation parity

## Context

The TUI is one renderer (`@opentui/solid`, `@opentui/core` 0.5.14) composed from
one shared component package (`packages/ui`, imported as `@ui`) plus three
feature bodies: the workflow dashboard (`src/tui/dash`), the observability /
wiki shell (`src/tui/otel`) and the embedded Environments feature
(`packages/devenv/cli/src/tui`, rendering `packages/ui/src/views`).

What exists today:

- `Selectable` / `Card` / `SelectableList` accept `onMouseUp` and forward it to
  a caller-supplied `onSelect(index)`; most callers never pass one, so tapping a
  row does nothing.
- `ScrollableList` already turns `onMouseScroll` into `props.onScroll?.(direction,
  delta)` with `preventDefault`/`stopPropagation`, but almost no caller passes
  `onScroll`, so wheel scrolling is dead on most lists.
- `GenericModal` renders a full-screen backdrop (`onMouseUp` → `onBackdropClick`)
  and a dialog box that stops propagation and invokes the global selection-copy
  handler. Only the location picker passes `onBackdropClick`.
- Two dozen hand-written `onMouseUp` handlers exist across the surfaces, with
  three different behaviours for the same gesture (picker row activates,
  destination/breadcrumb row only selects, sidebar row activates).
- The test renderer exposes mock pointer input (`t.mockMouse.click(x, y)`,
  `.drag`, `.pressDown`, `.moveTo`), already used by
  `test/otel/workspaceSidebar.test.tsx`, `test/dash/clipboardNotifications.test.tsx`
  and `test/dash/agentSessionView.test.tsx`.

Constraints that shape the design: keyboard behaviour must not change; mouse
handling must not create per-move render churn (`tui-input-responsiveness`);
selection and copy in transcripts/markdown/diffs must keep working
(`tui-clipboard-copy`); this is a TUI-only change (no server, store or
workflow-engine behaviour); the Orchestrator view and the env-setup flow are
being edited concurrently, so Orchestrator edits stay minimal.

## Goals / Non-Goals

**Goals:**

- One definition of the pointer semantics, in the shared primitives package, so
  every surface and every future panel inherits it.
- Parity: every action a developer can reach with the keyboard on a screen,
  panel, modal, list, tab, section or button is reachable with the mouse.
- A recorded inventory (below) that says, per surface item, what the pointer
  does — and the gap class it closes.
- Cheap: no hover state, no per-move handler, no polling, no timer; one state
  update per tap, identical to what the key already does.

**Non-Goals:**

- Right/middle-click context menus, drag-and-drop, draggable splitters or
  panel resizing (no draggable splitter exists in the TUI today; adding one is
  a separate change).
- Hover highlight: `@opentui/core` mouse support in this repo is consumed only
  as `onMouseUp` / `onMouseScroll`, hover rendering is unverified, and a
  per-move handler is the exact render churn `tui-input-responsiveness`
  forbids. The affordance is the existing selected-row style plus an accent on
  rows whose activation is not otherwise obvious.
- Any change to key bindings, key-resolution layers, stores, schemas, the
  server, the workflow engine or the CLI.
- Text selection/copy behaviour changes: the drag-vs-tap rule protects it, and
  the single global selection handler keeps its owner.
- Browser-style scrollbars you can drag: the wheel and key paths stay the only
  scroll inputs; the painted scrollbar stays an indicator (`ScrollableList`).
- Touch, terminal mouse-mode negotiation, or OSC sequence handling.

## Decisions

### D1 — The layer lives in `@ui`, not in a surface and not in `src/tui/shared`

`packages/ui/src/components/mouse/` holds the new module, exported from the
`@ui` barrel:

- `clickSemantics.ts` — pure, dependency-free: gesture classification
  (`tap` vs `drag`), the double-click window, and the select/activate
  resolution. Unit-tested without a renderer.
- `useRowMouse.ts` — the Solid binding used by row components: takes
  `{ index, selectedIndex, onSelect, onActivate }` and returns the
  `onMouseDown`/`onMouseUp` props to spread.
- `useTap.ts` — the binding for a click-only control (an expander glyph, a tab
  chip, a footer chip, a toast): one tap runs its handler, a drag or a
  non-primary button does not.
- `useWheelScroll.ts` — attaches wheel scrolling to a pane's own scroll owner.
- `dismissPolicy.ts` — the data table of which dialog kinds dismiss on a
  backdrop tap, and the shared `backdropDismiss(kind)` lookup.

`@ui` is already the single owner of the equivalent primitives
(`tui-shared-primitives`) and is imported by the shell, the dashboard, the
observability surface and the embedded Environments feature, so one module
reaches every surface. Alternatives: (a) per-surface handlers — rejected, it is
what produced three different behaviours for one gesture; (b) `src/tui/shared/`
— rejected, its consolidation already moved the implementations into `@ui` and
it is imported by neither the shell chrome nor `packages/devenv/ui`.

### D2 — Tap semantics, decided once

| Gesture | Meaning | Equivalent key |
| --- | --- | --- |
| Tap a row that is not selected | select/focus that row | `j`/`k` (or `↑`/`↓`) |
| Tap the already-selected row, where the surface activates rows | activate the row | `Enter` |
| Double tap (two taps ≤ 400 ms, same row) | select then activate, activation once; a further tap inside the window does not activate again | `j` then `Enter` |
| Tap a panel body/title | focus that panel | `J/K/H/L`, `Tab` |
| Tap a tab / section header / segment | switch to it | the tab/section key |
| Tap a footer or modal `help` key chip | run the registered command for that key when it takes no argument and is currently available | the key itself |
| Tap a scrollable pane | nothing (focus unchanged) | — |
| Wheel over a pane | scroll the innermost scrollable pane under the pointer | `j/k`, `PgUp/PgDn` |
| Tap the backdrop / a close control | dismiss, where Escape is a non-destructive dismiss | `Esc` |
| Drag (any cell change between down and up) | never a tap | — |
| Right/middle click, other buttons | ignored, never a tap | — |

A row is *activatable* when the surface binds an activation for it (a modal
option list, an artifact/evidence/agent/classification row, a settings item, a
sidebar workflow row, a trace/metric/log/topology row, a wiki tree row). A row
in a purely informational list selects only.

### D3 — Drag is never a tap (selection/copy protection)

`useRowMouse` records the pressed row index and cell; the up event is a tap only
when it names the same row index and the same cell, so a row instance a window
recompute recreated mid-gesture still taps and a release on another row never
does. Text selection by
drag, and the global selection-copy handler `GenericModal`/`Layout` already
invoke, therefore stay untouched. This is a pure function
(`classifyPointerGesture({ down, up })`) so it is unit-testable with synthetic
events, including a down inside a row and an up one cell below.

### D4 — Hit testing, scroll offsets and layering

The renderer dispatches a pointer event to the renderable under the pointer and
bubbles it to ancestors, so:

- the virtualized lists already hand the **absolute** item index to their row
  renderer, which the tap handler uses — no manual offset math, and a tap on a
  scrolled list cannot select the wrong row;
- borders/padding are the renderer's business: the handler is attached to the
  row box, not to the text inside it;
- a modal's dialog box keeps `stopPropagation` so a tap inside it never reaches
  the backdrop, and the backdrop only dismisses per D5;
- a hidden layer must not receive taps: `dash/App.tsx` keeps the panel grid
  mounted with `visible={false}` behind the agent-session page, so the grid's
  tap handlers are gated by the same `props.active?.()` / `anyModalOpen()`
  signals the keyboard uses. The implementation verifies this at the renderer
  boundary with a test that taps where a hidden grid row would be and asserts
  no selection change.

### D5 — Backdrop dismissal policy is data, and defaults to "explicit"

`dismissPolicy.ts` classifies each dialog kind:

- **Escape-parity (backdrop tap dismisses):** read-only or reversible dialogs —
  help, theme picker, workflow graph, findings, debug requests, cost, repair
  target picker, completed-action picker, plan-rejection reason picker,
  location picker, user-action picker, trace/metric/log detail modals, filter,
  sort, list-view pickers, markdown viewers.
- **Explicit-only (no backdrop dismissal, an explicit control instead):**
  dialogs that hold unsaved draft or secret input or perform an irreversible
  action — `NewWorkflowModal`, `DeveloperQuestionModal` (typed/custom answer),
  `CredentialsModal`, `NumberEditor` (bounded numeric draft), review and
  comment modals (typed comment), `ReviewRoute`, quit/delete/close confirmations
  (`QuitConfirmModal`, `DeleteWorkflowModal`, `CloseReasonModal`,
  `ConfirmDialog`), running-progress dialogs (`ProgressModal`,
  `ActionRunModal` while in flight).
- Where Escape itches (`Esc` = cancel) the backdrop tap is the same cancel when
  the dialog is in the first list; a dialog whose `Esc` is a *back* step inside
  a form (the wizard) is explicit-only.

`Esc` itself is unchanged in both cases: the policy only decides whether a
backdrop tap joins it.

### D6 — Clickable key chips, not new key text

The shared footer (`StatusBar`) and the modal footer (`HelpText`) already render
`[key] action` chips from the keybind catalog. A chip becomes a pointer target
for commands that take no argument (`?`, `Ctrl+P`, `T`, `r`, `c`, `d`, `m`, `g`,
`v`, `y`, `O`, and modal `Enter`/`Esc`/`y`/`n` where the surface's activation is
argument-free). Chips whose key needs a typed argument, a selected row or a
modal state stay inert — a chip must never do something the key would not do in
the current state. This delivers the "[Enter] Open becomes clickable" affordance
without adding any hint text to panel bodies (the repository forbids keybind
cheat text inside content).

### D7 — Wheel scrolling belongs to the pane under the pointer

`useWheelScroll` attaches `onMouseScroll` to the scroll owner of a pane: the
window of a `ScrollableList`, a `ScrollBoxRenderable` (transcripts, logs,
diffs, markdown), or the detail pane of a modal. Bubbling means the innermost
pane handles it first and stops propagation, so the wheel scrolls the pane under
the pointer, not the focused one, and never changes focus. Lists whose
`onScroll` moves the selection (trace list, issue list) keep that behaviour —
it is what `j/k` does. Panes with no scroll owner (fixed-height panels) ignore
the wheel.

### D8 — Reconciliation with the renderer-facing primitives

The change extends rather than forks:

- `Selectable`, `Card`, `WorkItemCard`: keep `onMouseUp` as the public prop for
  existing callers; internally route through `useRowMouse` so a plain
  `onMouseUp` caller keeps working while new callers pass `onActivate`.
- `SelectableList`: add `onActivate?: (index: number) => void` and
  `activatable?: (item: T, index: number) => boolean`; the row tap selects, a
  tap on the selected row (or a double tap) activates.
- `ScrollableList`: keep `onScroll`; callers that only want paging pass the
  shared page handler instead of leaving the wheel dead.
- `Panel`: gains an optional `onFocusRequest` (plus a `focusable` gate) and owns
  the region tap itself, so `setActivePanel` runs on a tap and no second region
  wrapper exists; a click-only control that is not a row uses `useTap`.
- `GenericModal`: `onBackdropClick` keeps its meaning and is resolved through
  `dismissPolicy.backdropDismiss(kind)`; `stopDialogClick` keeps swallowing.
- `ListViewModal`, `HelpModal`, `ThemePickerModal`, `FilterModal`, `SortModal`,
  `VerdictModal`, `ModalTabs`, `Table`: rows/tabs/filter field become pointer
  targets through the same hooks; no new primitive variants.

### D9 — Phasing (implemented in this order, each phase independently verifiable)

1. **Shared layer** — `mouse/` module, primitives wired, unit + renderer tests
   for the layer alone. Nothing else changes.
2. **Dashboard + modals** — the panel grid, the five detail panels, all dash
   modals, the agent-session page and its picker/filter lists.
3. **Orchestrator** — transcript wheel, prompt focus, transcript row toggles,
   model picker (minimal diff, separate commits, rebase on main first).
4. **Settings** — section list, item activation, numeric editor, agent preset
   view and its pickers.
5. **Environments feature** — tabs/tables/detail views/modals of the embedded
   devenv UI.
6. **Observability + Wiki + shared navigation** — remaining otel views, wiki
   tree and note modal, destination pages, location picker, breadcrumbs,
   toasts.
7. **Docs** — TUI READMEs, navigation docs, in-app help text; state once that
   the pointer drives the same actions.

### D10 — Tests

- Pure unit tests: gesture classification (tap/drag/double-click window),
  select-vs-activate resolution, dismissal policy table, and the footer chip
  availability rule — synthetic events, no renderer.
- Renderer tests (`testRender` + `t.mockMouse`): single tap selects; tap on the
  selected row activates; double tap activates once; tap after a `onScroll`
  page still hits the right row; tap on a border/outside a row does nothing;
  a tap below a modal does not reach the panel grid; a wheel event over an
  unfocused pane scrolls that pane and leaves the focused pane and selection
  alone; a drag selects text and does not change row selection.
- Per-surface parity tests: for the dashboard list, agents panel, tab strip,
  a modal's buttons, a settings item and a scroll pane, the same action is
  reachable by key and by pointer, asserting the same resulting state.
- Existing keyboard tests stay green and unchanged; no test may run with the
  developer's real config (`HOME`/`AGENTIC_CODING_CONFIG_DIR` point at a temp
  dir, as `test/support/isolate-config-root.ts` already does).

## Inventory

Columns: **keys** = the keyboard actions available on that item today;
**mouse today** = what the pointer already does; **gap** = the class of
missing affordance; **planned** = the affordance this change adds.

Gap classes: `select`, `activate`, `focus`, `scroll`, `dismiss`, `tabs`,
`buttons`, `input`, `none` (already covered).

### Shell chrome

| # | Surface | Where | Keys | Mouse today | Gap | Planned |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Workspace sidebar rows (workflow list) | `otel/components/WorkspaceSidebar.tsx` | `j/k` select, `Enter` open, `Esc` content | panel tap focuses, collapsed strip row toggles mode, pinned row activates on tap, expanded workflow rows only select | `select`, `activate`, `focus` | tap selects, tap-on-selected opens, panel tap focuses, collapsed rows select; row filter `f` and `+` reachable as chips |
| 2 | Sidebar mode toggles (`e`, expanded/permanent) | same | `e` | clickable today | `none` | keep; assert in a test |
| 3 | Footer key chips | `packages/ui/src/components/StatusBar.tsx` | every special key in the footer catalog, `?` help | none | `buttons` | chip runs its registered argument-free command (D6) |
| 4 | Breadcrumb row | `shared/navigation/BreadcrumbRow.tsx` | `Esc` parent, `Ctrl+O`/`Alt+Left` back, `h/l` cursor | tap selects ancestor and navigates | `none` | keep semantics, route through the shared tap rule, test |
| 5 | Location picker | `shared/navigation/LocationPicker.tsx` | type, `↑/↓`, `Enter`, `Esc` | row tap selects+accepts, backdrop tap closes | `scroll` | wheel scrolls the list; keep the rest |
| 6 | Destination pages (Home, categories) | `shared/navigation/DestinationPage.tsx` | `j/k`, `Enter` open | row tap only selects | `activate` | tap-on-selected/double tap opens |
| 7 | Toasts | `dash/ui/Notification.tsx`, `otel/components/Notification.tsx` | dismiss/expiry path | none | `buttons` | tap dismisses through the store's existing dismiss path; a toast carrying a required action keeps its explicit control |
| 8 | Lifecycle/quit dialogs | `lifecycle/LifecycleModal.tsx`, `QuitConfirmModal.tsx` | explicit confirm keys | none | `buttons` | explicit buttons clickable; backdrop never confirms |

### Dashboard detail (workflow dashboard body)

| # | Surface | Where | Keys | Mouse today | Gap | Planned |
| --- | --- | --- | --- | --- | --- | --- |
| 9 | Panel grid focus | `dash/App.tsx`, `Panel.tsx` | `J/K/H/L` move, `Tab` local focus, `Ctrl+S` | none | `focus` | tap on a panel (title or body) focuses it |
| 10 | Panel scrolling | `dash/App.tsx` ScrollBox refs, `ScrollableContent` | `j/k`, `↑/↓` scroll focused panel | none | `scroll` | wheel scrolls the pane under the pointer |
| 11 | Change panel (phase/steps, gate prompt, changed files) | `dash/panels/ChangePanel.tsx`, `dash/ui/PhaseStatus.tsx` | `j/k` scroll, `Enter` approve gate/review files, `g` graph | none | `focus`, `scroll`, `buttons` | focus+wheel on tap; `Enter`/`g` via the panel's footer chips and any activatable row the panel renders |
| 12 | OpenSpec/artifact panel | `dash/panels/OpenSpecPanel.tsx` | `j/k` select, `Enter` open artifact | none | `select`, `activate`, `scroll` | tap select, tap-on-selected open, wheel |
| 13 | Classifications panel | `dash/panels/ClassifierPanel.tsx` | `j/k` select, `Enter` view decision | none | `select`, `activate` | same |
| 14 | Agents panel (agents, steps, findings summary) | `dash/panels/AgentsPanel.tsx` | `j/k` select, `Enter` focus agent/open session, `v` verifier result | none | `select`, `activate`, `scroll` | tap select, tap-on-selected open session, `v` via chip, wheel |
| 15 | Evidence panel (entries + inline preview) | `dash/panels/EvidencePanel.tsx` | `j/k` select, `Enter` open externally, `y` copy path | none | `select`, `activate`, `scroll` | tap select, tap-on-selected open, `y` via chip, wheel |
| 16 | Evidence/finding preview viewers | `packages/ui` viewers | `PgUp/PgDn` (viewer) | none | `scroll` | wheel |
| 17 | Agent session page (transcript, prompt, tool blocks) | `dash/ui/AgentSessionView.tsx` | `Esc` back, `Enter` send, `Shift+Enter` newline, `PgUp/PgDn` scroll, `Ctrl+T`/`Ctrl+O` toggles, `Tab` complete, `↑/↓` history | tool/thinking/section rows toggle | `scroll`, `input`, `select` | wheel over the transcript; tap on the prompt area focuses the input; tap selects history/completion rows and tap-on-selected sends; keep row toggles |
| 18 | Agent session picker/filter list | `dash/ui/AgentSessionView.tsx` (`ListViewModal`) | type, `j/k`, `Enter` select, `Esc` cancel | row select (no activation) | `activate`, `input` | tap-on-selected activates, filter field focus on tap |
| 19 | Developer-question modal | `dash/ui/DeveloperQuestionModal.tsx` | `Tab`/`Shift+Tab` question, `↑/↓` choose, `Enter` select option, `Alt+Enter` submit, `d` detail, `PgUp/PgDn` context, `Esc` cancel | none | `select`, `activate`, `tabs`, `scroll`, `buttons` | option rows select, tap-on-selected picks that option, question tabs clickable, context pane wheel, Cancel/Submit chips clickable, no backdrop dismiss |
| 20 | New-workflow wizard | `dash/ui/NewWorkflowModal.tsx` | typing fields, `Enter` next/create, `Alt+Enter`, `Esc` back, `/` filter, option lists | option-list row select | `input`, `activate`, `buttons` | field tap focuses, list tap-on-selected selects, `Next`/`Create`/`Back` chips clickable, no backdrop dismiss |
| 21 | Preset switcher | `dash/ui/PresetSwitcherModal.tsx` | `j/k`, `Enter` switch+retrigger, `Esc` cancel | none | `select`, `activate`, `dismiss` | tap select, tap-on-selected switches (explicit activation), backdrop cancels |
| 22 | Credentials modal | `dash/ui/CredentialsModal.tsx` | field typing, `Enter` submit, `Esc` cancel | none | `input`, `buttons` | field tap focuses, Submit/Cancel chips clickable, no backdrop dismiss |
| 23 | Cost modal | `dash/ui/CostModal.tsx` | `j/k` scroll / navigate, `Enter` message detail, `Esc` close | none | `select`, `activate`, `scroll`, `dismiss` | tap select, tap-on-selected detail, wheel, backdrop closes |
| 24 | Findings modal | `dash/ui/FindingsModal.tsx` | `j/k` select, `PgUp/PgDn` scroll finding, `Enter` open editor, `Esc` close | none | `select`, `activate`, `scroll`, `dismiss` | same as cost |
| 25 | Debug requests modal | `dash/ui/DebugRequestsModal.tsx` | `j/k` request, `J/K` scroll report, `Enter` open report file, `Esc` close | none | `select`, `activate`, `scroll`, `dismiss` | tap select, tap-on-selected opens, wheel on report, backdrop closes |
| 26 | List-view dialogs (repair target, completed-action picker, user action, plan rejection) | `dash/modals/Overlays.tsx` (`ListViewModal`) | `j/k`, typing reason, `Enter`, `Esc` | row select only | `activate`, `input` | tap-on-selected activates, reason field focus on tap |
| 27 | Workflow graph modal | `dash/modals/WorkflowGraphModal.tsx` | scroll keys, `Esc` | none | `scroll`, `dismiss` | wheel, backdrop closes (`Esc` parity) |
| 28 | Help modal | `shared/HelpModal.tsx` | `j/k` scroll, `Esc` | none | `scroll`, `dismiss` | wheel, backdrop closes |
| 29 | Theme picker | `shared/ThemePicker.tsx` / `ThemePickerModal` | type filter, `↑/↓`, `Enter`, `Esc` | none | `select`, `activate`, `input` | tap select+apply on selected, filter tap focuses, backdrop closes |
| 30 | Review routes (review, dialogue, plan review, developer review, comment) | `dash/routes/ReviewRoute.tsx`, `DialogueRoute.tsx` | search, `j/k`, comment anchors, `Esc` | markdown/diff anchors | `scroll`, `input` | wheel, comment input focus on tap; typed-comment dialogs explicit-only |
| 31 | Verdict modal | `packages/ui/…/VerdictModal` | scroll, toggles, `Esc` | none | `scroll`, `dismiss` | wheel, backdrop closes |
| 32 | Error dialogs / notification overlay | `ErrorDialog`, `ErrorModalOverlay` | `Enter`/`Esc` | none | `buttons` | explicit chips clickable |

### Orchestrator page

| # | Surface | Where | Keys | Mouse today | Gap | Planned |
| --- | --- | --- | --- | --- | --- | --- |
| 33 | Orchestrator transcript | `orchestrator/OrchestratorView.tsx` | `PgUp/PgDn` scroll, `Ctrl+T`/`Ctrl+O` toggles | none | `scroll` | wheel; row toggles like the agent session view (minimal, separate commit) |
| 34 | Orchestrator prompt input | same | typing, `Enter` send, `↑/↓` history | none | `input`, `select` | tap focuses the input; history rows select on tap |
| 35 | Orchestrator model/thinking picker | same (`ListViewModal`) | `j/k`, `Enter`, `Esc` | row select | `activate`, `input` | tap-on-selected activates, filter focus, backdrop closes |

### Settings

| # | Surface | Where | Keys | Mouse today | Gap | Planned |
| --- | --- | --- | --- | --- | --- | --- |
| 36 | Settings section list | `settings/SettingsSectionView.tsx` | `j/k` select, `Enter` activate, `R` reload, `T` theme, `?` | none | `select`, `activate`, `scroll`, `buttons` | tap select, tap-on-selected activates the item's action (theme picker, navigate, numeric editor, retry, browser install), wheel, `R`/`T` chips |
| 37 | Bounded numeric editor | `settings/NumberEditor.tsx` | digits, `Enter` save, `Esc` cancel | none | `input`, `buttons` | field focus on tap, Save/Cancel chips, no backdrop dismiss |
| 38 | Agent preset view (menu, profiles, editor fields, pool, provider picker, install prompt, delete confirm) | `settings/AgentPresetsView.tsx` | `j/k` lists, `Enter` activate, `y/Enter` confirm delete, `Esc/n` cancel, `i` install | none | `select`, `activate`, `input`, `tabs`, `buttons` | lists select/activate, field taps focus, select/number editors as above, provider/install chips clickable, delete confirmation explicit-only, wheel |

### Environments feature (embedded devenv UI)

| # | Surface | Where | Keys | Mouse today | Gap | Planned |
| --- | --- | --- | --- | --- | --- | --- |
| 39 | Tab/section strip | `packages/devenv/cli/src/tui/app-opentui.tsx`, `ui/views/Table.tsx` | tab keys | tab row clickable | `none` | keep, cover with a parity test |
| 40 | Repository/app/issue/CR/task/job/test tables | `ui/views/Table.tsx`, `IssueView`, `ChangeRequestView`, `JobsDetailView`, `TestResultsDetailView`, `KubernetesClusterView` | list keys (`nav-keys`, `*-list-keys`) | row tap selects (`Table.onSelect`), `IssueView`/`ChangeRequestView` wheel scroll | `activate` | tap-on-selected opens the detail, wheel everywhere |
| 41 | Detail views (app, issue, CR, jobs, tests, kubernetes, timeline, references, discussions, changed files, properties) | `ui/views/*DetailView.tsx`, `ChangedFilesView`, `TimelineView`, `ReferencesView`, `DiscussionsView` | detail keys, `Esc` back | anchors in diff/markdown review | `scroll`, `input` | wheel on every scroll pane, comment/scroll targets otherwise unchanged |
| 42 | Slot & action views | `cli/src/tui/views/slots-view.tsx`, `actions-view.tsx`, `action-run-modal.tsx` | action keys (`actions-keys`) | action-run modal sets focused panel on tap | `select`, `activate`, `scroll` | action rows select/activate, log pane wheel, no backdrop dismiss while running |
| 43 | Environment modals (add repository, assignee, branch create, close reason, comment, connect provider, confirm, filter, label, log, markdown, passphrase, sort, task add/args, test detail, worktree manager, theme, first steps) | `ui/views/*`, `views/modal-overlays.tsx` | modal keys per `keyboard/*-keys.ts` | `ModalTabs` tabs, some review anchors | `select`, `activate`, `tabs`, `input`, `buttons`, `dismiss` | list rows follow D2, tabs clickable, fields focus on tap, footer chips clickable, backdrop dismissal per D5 (confirm/passphrase/typed-comment explicit-only) |
| 44 | Splashes (startup, shutdown, progress) | `views/*splash.tsx` | none | none | `none` | none (no interaction by design) |
| 45 | Help/guides view | `ui/views/HelpView.tsx` | guide list keys | guide row tap opens the guide (`onGuideSelect`) | `none` | keep; cover with a parity test |

### Observability and Wiki

| # | Surface | Where | Keys | Mouse today | Gap | Planned |
| --- | --- | --- | --- | --- | --- | --- |
| 46 | Trace list | `otel/views/TraceListView.tsx`, `otel/app/App.tsx` | `j/k` select, `Enter` open, `[`/`]` page, `/`, `F`, `O`, `w` | row tap selects | `activate`, `buttons` | tap-on-selected opens, wheel pages, `/`/`F`/`O`/`w` chips |
| 47 | Trace tree / span detail | `otel/views/TraceTreeView.tsx`, `SpanDetailView.tsx` | `j/k`, `h/l` collapse/expand, `g/G`, `Enter` | row tap selects, expander tap toggles | `activate` | tap-on-selected opens span detail, wheel |
| 48 | Metrics list + detail | `otel/views/MetricsView.tsx`, `MetricDetailView.tsx` | `j/k`, `Enter` detail | row tap selects+opens | `scroll` | wheel on detail |
| 49 | Logs list + detail | `otel/views/LogsView.tsx`, `LogDetailView.tsx` | `j/k`, `Enter` detail, `/` search | row select; detail has a dead `onMouseUp={() => {}}` | `activate`, `scroll` | tap-on-selected opens detail, wheel, remove the dead handler |
| 50 | Topology graph | `otel/views/TopologyView.tsx`, `otel/components/TopologyGraph.tsx` | `j/k`, `Enter` detail | node tap selects | `activate` | tap-on-selected opens the service detail |
| 51 | Workspace tabs / status bar | `otel/app/App.tsx`, `components/StatusBar.tsx` | tab keys, `?`, host keys | copy-selection tap | `tabs`, `buttons` | tab strip clickable, chips clickable |
| 52 | Wiki tree + note modal | `otel/views/WikiView.tsx` | `j/k`, `Enter` open/expand, `c` comment, `v` visual, `n/N` note, `F` frontmatter, `Esc` ladder | tree row selects | `activate`, `scroll`, `tabs` | tap-on-selected opens, wheel on the note, note action chips clickable; comment input explicit-only |
| 53 | Search/filter/sort modals | `otel/components/*Modal`, `SearchHeader` | `/`, `F`, `O`, `Esc` | none | `select`, `input`, `buttons` | rows select/activate, filter tap focuses, chips clickable |
| 54 | Delete-workflow / trace modals | `otel/components/DeleteWorkflowModal.tsx`, `TraceModals.tsx` | confirm keys | none | `buttons` | explicit confirm clickable, no backdrop confirm |

### Cross-cutting

| # | Surface | Where | Keys | Mouse today | Gap | Planned |
| --- | --- | --- | --- | --- | --- | --- |
| 55 | Scrollable lists | `ui/components/ScrollableList.tsx` | `j/k` etc. (caller) | wheel wired but unused by most callers | `scroll` | every caller passes a scroll handler; the wheel scrolls the list under the pointer |
| 56 | Markdown / diff / log viewers | `MarkdownViewer`, `diffView`, `LogView` | scroll + copy keys | selection copy via global handler | `scroll` | wheel; drag stays selection, never a tap |
| 57 | Selection copy | `ui/components/selectionCopy.ts` | `Ctrl+Shift+C` | global mouse-up handler | `none` | unchanged; D3 guarantees a drag never mutates selection |
| 58 | Draggable splitters / panel resize | — (no such control exists) | — | — | `none` | out of scope (see Non-Goals) |

## Risks / Trade-offs

- **A tap that also drags changes selection** → D3's same-cell rule; covered by
  a renderer test with `t.mockMouse.drag`.
- **Wheel handling swallows keys or double-scrolls** → the pane's own scroll
  owner handles the event and stops propagation; a test asserts the focused
  pane's offset and selection are unchanged when the pointer is elsewhere.
- **Backdrop dismissal discards work** → D5 classifies each dialog kind; the
  guarded list is explicit-only, and a test asserts a backdrop tap on the
  wizard/credentials/question dialogs changes nothing.
- **Render churn** → no hover handler, no `onMouseMove`, no timers; the
  double-click window is two module-level values read on mouse-up; a tap
  performs exactly the state update its key performs.
- **Family divergence** (dash, otel, devenv fork wrappers) → the layer lives in
  `@ui`, family entry points re-export; `test/dash/devenvUiPrimitives.test.ts`
  already asserts the entry points are the same function objects, and the new
  exports extend that assertion.
- **Concurrent edits** in `src/agent-host/orchestrator.ts`,
  `src/tui/orchestrator/*` and the env-setup flow → Orchestrator changes are a
  separate, minimal commit that only adds tap handlers; the final summary
  rebases on main.
- **Hidden layers receiving taps** → the grid is gated by the same active
  signals the keyboard uses, verified by a renderer test.
- **Unverified renderer capability** (hover, event button identity) → the
  phase-1 task records the actual `@opentui/core` mouse event surface from the
  installed package and adapts the ignored-button rule if the event exposes no
  button identity (then every event is treated as a left tap unless it carries
  a scroll).

## Migration Plan

Additive: no data, schema or config migration. Land phase 1 (shared layer)
first; each later phase touches only its own surfaces and can be reverted
independently. Rebase on `main` before the final summary. Rollback is reverting
the commits — no persistent state is written by mouse handling.

## Open Questions

- Should a wheel event over a *focused* pane keep scroll parity with `j/k` where
  `j/k` moves the selection instead of the viewport (trace list, issue list)?
  Default: keep the existing `onScroll` behaviour of those lists (selection
  moves), since that is what the key does.
- Should the collapsed sidebar strip expose per-row actions as small clickable
  glyphs, or stay select-only with the actions on the expanded panel? Default:
  select-only when collapsed; actions live on the expanded panel's chips.
- Toasts: is a click-to-dismiss toast acceptable where no key dismisses it?
  Default: yes for transient toasts only, never for one carrying a required
  developer action.

## Renderer capability, recorded (task 1.2)

Read from the installed `@opentui/core` / `@opentui/solid` 0.5.14 in this
worktree before implementing, instead of assumed:

- **Events**: `RenderableOptions` exposes `onMouse`, `onMouseDown`, `onMouseUp`,
  `onMouseMove`, `onMouseDrag`, `onMouseDragEnd`, `onMouseDrop`, `onMouseOver`,
  `onMouseOut` and `onMouseScroll`. The implementation uses `onMouseDown` +
  `onMouseUp` (a tap) and `onMouseScroll` (the wheel) only; there is no
  `onMouseMove`/hover handler anywhere in the layer.
- **Payload**: `MouseEvent { type: "down" | "up" | "move" | "drag" | "drag-end" |
  "drop" | "over" | "out" | "scroll"; button: number; x; y; modifiers;
  scroll?: { direction: "up" | "down" | "left" | "right"; delta }; target;
  currentTarget; isDragging?; stopPropagation(); preventDefault() }`. The button
  *is* exposed (`MouseButton.LEFT = 0`, `MIDDLE = 1`, `RIGHT = 2`), so D2's
  ignored-button rule is implemented literally (`isPrimaryPointerButton`) and no
  adaptation of task 1.5 was needed.
- **Hit testing and bubbling**: the renderer hit-tests the cell under the
  pointer and dispatches to that renderable, then bubbles through `parent` while
  `propagationStopped` is false; a scroll with nothing under the pointer falls
  back to the focused renderable. `currentTarget` is re-assigned to each
  renderable as the event bubbles, which is what the tap rule compares.
- **Auto-focus**: `CliRenderer.autoFocus` defaults to true, so a left mouse-down
  focuses the nearest focusable ancestor unless the event was `preventDefault`ed.
  That is how every `<input>`/`<textarea>` (the agent-session prompt, a modal
  field, a filter box) gains focus from a click without the shared layer adding
  a focus call of its own.
- **Scroll boxes scroll natively**: `ScrollBoxRenderable.onMouseEvent` handles
  the wheel, so `ScrollableContent` panes needed no hook; `useWheelScroll` is
  for the windowed lists, which have no scroll box.
- **Hidden layers**: an unpainted (`visible={false}`) renderable is not in the
  hit map, so the dashboard grid mounted behind the agent-session page cannot
  take a tap — asserted by a renderer test rather than assumed.
- **Test surface**: `TestRendererSetup.mockMouse` (`click`, `doubleClick`,
  `pressDown`, `release`, `drag`, `moveTo`, `scroll`) and `mockInput`
  (`pressEnter`, …), used by `test/dash/mouseInteraction.test.tsx`.

## Activation by key dispatch (implementation decision)

Where a surface expresses a row action only as a keymap binding (the dashboard
panels' `Enter`, a modal's `Enter`, a settings item), the shared layer dispatches
*that key* through the renderer's own key handler
(`renderer.keyInput.processParsedKey`), the same bridge
`createDefaultOpenTuiKeymap(renderer)` listens on. This keeps one activation path
per surface — the keymap layer keeps deciding what is available in the current
state — instead of a second action table next to the bindings, and it is what
makes footer/modal key chips exact rather than approximate
(`useKeybindChips`, asserted end to end in
`test/dash/mouseInteraction.test.tsx`).

## Implementation status of the inventory

Applied (shared layer first, then the surfaces):

- The whole shared mouse layer in `packages/ui/src/components/mouse/` plus its
  wiring into `ScrollableList` (rows, wheel, gesture holder), `SelectableList`,
  `Selectable`, `Card`, `WorkItemCard`, `Table`, `Panel`, `GenericModal`,
  `ListViewModal`, `HelpText`/`StatusBar` (chips), the toast, `HelpModal` and
  `VerdictModal` (inventory rows 3, 5–15, 17–30, 36–38, 40, 46–53, 55–57).
- Dashboard: panel focus/select/activate (rows 9–15), the dash modals with the
  shared tap rule and the dismissal policy (rows 19–29, 31), the agent-session
  page, its completion rows and its picker (rows 17–18) and the panel grid's
  hidden-layer gate (row 9).
- Settings: section rows (select, activate, wheel) and the agent-preset lists
  (rows 36–38).
- Environments: tables and slot rows open the selected row's detail (rows 40, 42),
  detail/log panes scroll natively (rows 41, 56), guarded dialogs stay explicit
  (rows 43–44) and `HelpView` keeps its tap (row 45).
- Observability/Wiki/shell: trace list, trace tree (tap + wheel), metrics, logs,
  topology, wiki tree, location picker, destination rows, breadcrumbs, sidebar,
  footer chips and toasts (rows 1–7, 46–54).

The keyboard/mouse parity tests live in `test/dash/mouseInteraction.test.tsx`,
`test/dash/mouseNavigation.test.tsx` (the agents panel, against the real panel
with the demo fixture), `test/settings/mouseSettings.test.tsx`, `test/ui/mouseInteraction.test.ts`,
`test/ui/environmentMouse.test.tsx` (table, slot row, guarded dialog, detail
wheel) and `test/otel/mouseNavigation.test.tsx`; the mouse layer's exports are
also asserted to be one implementation family in
`test/dash/devenvPrimitives.test.ts`.

## Verifier round: the fixes it produced

Six verifiers agreed on three defects, all fixed here:

1. **A backdrop tap confirmed instead of dismissing.** The four dashboard
   pickers (repair target, completed action, required user action, plan
   rejection) wired `onBackdropClick` to `activateRow()` — a stray click ran the
   dialog's `Enter` (repair, run, start, reject). They now spread
   `useModalBackdrop({ kind })`, which dispatches the dialog's own `Esc` and
   lets that layer decide; the row tap keeps `onActivate`. Their kinds stay in
   the escape-parity band because their `Esc` is a cancel.
2. **The backdrop was not a tap.** `GenericModal`'s backdrop was a bare
   `onMouseUp` that ignored the button, ignored the drag rule, did not
   `stopPropagation` and defaulted to an escape-parity kind, so an unnamed
   dialog dismissed by accident. It now pairs down/up through
   `classifyPointerGesture`, requires the primary button, only accepts an event
   whose target *is* the backdrop, stops propagation once it acted, and is
   fail-closed: an unnamed kind is `confirm` (explicit), and every dialog that
   wants backdrop dismissal names its kind (`location-picker`, `artifact-preview`,
   `error-dialog`, `action-run`, `comment`, …).
3. **Two mechanisms for one gesture.** `MouseFocusArea` was replaced by
   `Panel.onFocusRequest`; `useTap` is the one binding for click-only controls
   (footer chips, expander glyphs, question tabs, topology nodes, toasts), so no
   surface carries a raw `onMouseUp` any more. `ScrollableList` also owns one
   gesture holder per list, so a window recompute cannot discard a press, and it
   only swallows the wheel when it can actually act.

Also corrected: `resolveRowInteraction` activates only the row the pointer
named (the double-tap record is informational, since selection is synchronous),
and the help modal's row contract is shared (`helpModalRows`/`helpModalRowCount`
in `keybinds.ts`) so the dashboard's and the shell's scroll clamps include the
`Mouse` section instead of hiding it.

Residual (recorded, not silent): `slots-view`/`actions-view` expose no scroll
owner for their log panes (the wheel correctly changes nothing there), and the
in-app `?` help states pointer parity as its own `Mouse` section plus the two
TUI READMEs — never as key text inside a panel or tab body.

### Second verifier round

The second round's findings were warnings about precision rather than defects;
all are fixed:

- **The gesture is keyed on the row, not the renderable** (`useRowMouse`): the
  down sample carries the index, so a recreated row instance at the same cell is
  still a tap, and a release on a different row is `none`.
- **A repeat activation inside the window is inert**: the tap record carries
  `activated`, so an accidental double click cannot run a dialog's confirm
  action twice, while `Enter` still repeats on purpose.
- **Nested controls consume their tap**: `useTap` gained `stopPropagation`, used
  by the trace-tree expander and the sidebar's mode glyph (one gesture, one
  action).
- **No raw `onMouseUp` on a control remains**: the diff/markdown anchors, the
  dependency-tree rows (whose debug `console.error` probe is gone too), the
  provider rows (which now also select and edit through the shared rule, with
  the store's setter wired at the call site), and the sidebar glyphs all use
  `useTap`/`useRowMouse`.
- **The wheel is only swallowed when the pane can act** (`enabled` in
  `useWheelScroll`, plus `items.length > 0`), and a list whose selection triggers
  a read — the evidence preview — opts out with `wheelMovesCursor={false}`, so
  the wheel cannot issue a read per event (`tui-input-responsiveness`).
- **The trace tree's wheel is O(1)**: it passes the index it already computed to
  a new `onSelectIndex`, which the shell answers with the same body `j`/`k` runs.
- **One row-count contract for help**: `modalHelp.ts`'s clamp now calls
  `helpModalRowCount` instead of keeping its own count, so the modal `?` help can
  reach the appended `Mouse` rows.
- **Only the primitives carry handlers.** The family-identity table in
  `test/dash/devenvUiPrimitives.test.ts` compares the environment package's entry
  point (`packages/devenv/cli/src/tui/ui.ts`, a re-export of `@ui`) with the
  dashboard's imports; because that barrel resolves to the same module, the table
  proves a *re-export* rather than the absence of a fork. The fork guard is the
  source assertion added to `test/ui/packageBoundaries.test.ts`: no file under
  `packages/devenv/**` declares its own `useRowMouse`/`useTap`/
  `classifyPointerGesture`/`backdropDismiss`, and every pointer import comes from
  `@ui` (or the barrel). That is the assertion that can fail on a reintroduced
  copy, and it is recorded as such instead of being claimed by the identity
  table.
- The dashboard's panel-pointer wiring moved to `dash/panel-pointer.ts` so the
  order it guarantees (select the resolved row, then dispatch `Enter`) and its
  hidden-grid gate are asserted directly.
- **The wheel gate is read by the list itself** (`ScrollableList` passes
  `enabled` and honours `wheelMovesCursor`), so a list with no cursor binding
  really does let the event bubble; the evidence pane is inert on the wheel, and
  a renderer test nests an inert list in a scroll box and asserts the box moves.
- Remaining bare row handlers are gone: the diff line row, the markdown block
  row, the review viewers' anchors, the provider rows (whose activation now
  dispatches the dialog's own `e`, and whose footer hints are real chips) — all
  through `useTap`/`useRowMouse`; the dependency tree's leftover `console.error`
  probe in `content-router.tsx` is deleted with it.
- A press that a row re-creation would have dropped still completes: `SlotsView`
  hands its rows one shared gesture holder, and a renderer test replaces the row
  object mid-press.
- A control nested in a clickable region consumes its tap (trace-tree expander,
  sidebar mode glyphs), asserted by a renderer test with a region and a nested
  glyph.
- The modal option list has its own parity test
  (`test/dash/modalMouse.test.tsx`), and the review viewers have a drag test
  (`test/ui/reviewMouse.test.tsx`).

### Fourth verifier round

The fourth round found the pointer layer's *reach* incomplete rather than its
semantics wrong. Fixed:

- **The theme picker's rows were not pointer targets at all**, and the `onSelect`
  the modal declared was dropped on the floor: `ThemePicker` now takes the
  callback and renders every row through the shared rule, and both callers (the
  dashboard overlay and the observability shell) hand it their index setter.
- **A row index may now be an accessor** (`index?: number | (() => number)`),
  resolved on every event, and a row's gesture is bound by *row identity*: a
  release on another row instance **and** another index is dropped, while a row
  the store replaced at the same position or a row whose position moved under a
  stable instance still completes its tap — the autocomplete row in the agent
  session view was freezing its index at creation and could activate the wrong
  command after a filter reorder.
- **Every remaining read-only list is pointer-reachable**: the help modal (the
  surface built for reading a long list) and the workflow-graph dialog scroll
  under the wheel through the offsets their callers already own, the wiki tree
  moves its cursor on the wheel, and the observability filter/sort dialogs and
  the environment task-arguments dialog select their rows (their wrappers forward
  the setters the shell owns).
- **One holder per list, explicitly**: the lists that built a holder inside each
  row (`DebugRequestsModal`, `MetricsView`, `TraceTreeView`) now create one and
  hand it to the rows they render, exactly as `ScrollableList` and `SlotsView`
  do. The context-provider variant was tried and dropped: the extra component
  boundary shifted the rendered rows, which the renderer tests caught.

### Fifth verifier round

The fifth round found the *environment* app (and two shared rows) left behind by
the previous wiring pass:

- **A real mis-behaviour**: the filter dialog's *criteria* row borrowed the value
  pane's callback, so a tap on the selected criteria row changed a filter
  *value* and applied it. Each pane now gates and reports its own selection
  (`FilterRow` takes an explicit `activatable`), and the row's activation is the
  dialog's own `Enter` dispatched through the keymap rather than a second copy of
  another pane's handler.
- **The embedded Environments dialogs were still mouse-inert** although the
  shared components had learned pointer rows: all five filter dialogs, all five
  sort dialogs and the theme picker now pass the store setters their key layer
  already drives (`ThemePickerView` gained `onSelectIndex`).
- **The remaining frozen row indices are gone** (`MetricsView`, `slots-view`,
  `SortModal`, `TaskArgsModal`): every row whose position can move under a stable
  instance passes the index accessor `useRowMouse` resolves per event.
- **The trace tree's wheel box is always mounted**, so its `enabled` gate is the
  thing that decides (the mount guard had made the gate dead code), and the
  empty-tree case now proves the event reaches an enclosing scroll owner instead
  of asserting a no-op. Its row activation has the positive test the round
  asked for (tap selects through `onSelect(path)`, tap on the selected row
  dispatches `Enter`, and the key matches).
- The task-arguments dialog's rows activate through the dialog's `Enter` instead
  of re-selecting (the previous shape made the activation branch a visible
  no-op), and the dead spy scaffolding in the new test files is gone.

### Sixth verifier round

- **A row's identity, not its encoded index, decides a double tap.** Every
  `Selectable` renders one row and therefore reports index 0, so with a shared
  gesture holder a fast second tap on *another* row was mistaken for a double tap
  on the first (silently swallowing a legitimate activation of the second row).
  The tap record now carries the row instance and two taps are one double tap
  only when they are the same row.
- **A synthesized stroke carries the sequence a real keypress carries.** The
  environment layer matches Space by `event.sequence === " "`, so its `[Space]`
  chips and the `activateKey="Space"` activation were dead; `parsedKeyFrom` now
  sets the sequence for Space and any printable single stroke (named keys keep an
  empty sequence, since their control bytes are not reproducible).
- **The activation stroke belongs to the surface**: `FilterModal`/`SortModal`
  take `activateKey` (default `Enter`), and the environment's ten dialogs pass
  `Space`, which is the key that applies there — `Enter` closes those dialogs.
- **A tap in the task-arguments dialog focuses that pane** (`onFocusPane`), so the
  `j`/`k` that follows moves the list the developer clicked instead of the other
  pane.
