# Tasks — TUI mouse navigation parity

Phases are ordered by dependency (design D9); each phase is independently
verifiable. Every phase ends with `bun run lint`, `bun run type-check` and the
phase's own focused tests — never a repository-wide suite. Any test run uses an
isolated `HOME`/`AGENTIC_CODING_CONFIG_DIR` (as `test/support/isolate-config-root.ts`
already does); never the real store or config dir. The plan phases are scoped so
that each phase is independently verifiable, and the phases do not prescribe a
repository-wide test command.

## 1. Baseline and renderer capability evidence

- [x] 1.1 Inventory every pointer handler in `src/tui` and `packages/ui` (`onMouseUp`,
      `onMouseScroll`, dead handlers such as `otel/views/LogDetailView.tsx`) and record it in
      design.md's inventory if it differs from what the plan recorded.
- [x] 1.2 Establish the installed renderer's pointer surface: read the mouse event type
      and renderable pointer props in the installed `@opentui/core` / `@opentui/solid`
      packages, and write a short note in design.md recording the available events, their
      payload fields (button identity, cell coordinates, `scroll.direction`/`delta`),
      whether a drag is visible, and what bubbling/`stopPropagation` does.
- [x] 1.3 Prove tap reachability at the renderer boundary first: a renderer test using
      `t.mockMouse.click(x, y)` that taps a shared `SelectableList` row and asserts the
      selected index changes (extend `test/dash/sharedPrimitives.test.tsx`).
- [x] 1.4 Record the baseline for the affected surfaces' existing keyboard tests
      (`bun test test/dash test/otel test/ui`) so later phases can show them unchanged.
- [x] 1.5 If 1.2 shows the renderer exposes no button identity, adapt the ignored-button
      rule (design D2) and note the adaptation in design.md before phase 2.

## 2. Shared pointer layer in `@ui`

- [x] 2.1 Create `packages/ui/src/components/mouse/clickSemantics.ts` with pure
      `classifyPointerGesture({ down, up })` (same renderable and same cell required) and
      `resolveRowInteraction({ index, selectedIndex, activatable, lastTap })` returning
      `select` / `activate` / `none` plus the new double-tap record; no timers, no global
      mutable state beyond the caller-passed record.
- [x] 2.2 Create `packages/ui/src/components/mouse/useRowMouse.ts` — the Solid binding that
      turns down/up events into `onSelect` / `onActivate` calls using 2.1, with no signal on
      pointer move.
- [x] 2.3 Create `packages/ui/src/components/mouse/useWheelScroll.ts` — attaches
      `onMouseScroll` to a pane's scroll owner (a windowed list's page handler or a
      `ScrollBoxRenderable`), stops propagation and calls `preventDefault` once handled.
- [x] 2.4 Give the region tap one owner: `Panel` gained `onFocusRequest` plus a
      `focusable` gate (the dashboard panel grid uses it), and
      `packages/ui/src/components/mouse/useTap.ts` is the binding for a click-only
      control that is not a row. The separate `MouseFocusArea` wrapper the plan
      proposed was dropped in favour of the `Panel` prop, so there is one mechanism.
- [x] 2.5 Create `packages/ui/src/components/mouse/dismissPolicy.ts` — the data table of
      dialog kinds and `backdropDismiss(kind, { hasDraft, running, irreversible })`, with the
      guarded kinds from design D5 (wizard, developer question, credentials, numeric editor,
      review/comment, quit/delete/close confirmations, running progress).
- [x] 2.6 Export the module from the `@ui` barrel and assert in
      `test/dash/devenvUiPrimitives.test.ts` that every family entry point resolves to the
      same function objects as the shared implementation (design D1, tui-shared-primitives).
- [x] 2.7 Wire the primitives: `Selectable` keeps `onMouseUp` and gains `onActivate`;
      `SelectableList` gains `onActivate`/`activatable`; `Card` and `WorkItemCard` forward
      both; `Panel` gains `onFocusRequest`; `ScrollableList`'s existing `onScroll` is routed
      through `useWheelScroll` so no caller can leave the wheel dead.
- [x] 2.8 Wire the dialog chrome: `GenericModal` resolves backdrop dismissal through
      `dismissPolicy` while keeping `stopDialogClick` swallowing; `ListViewModal`,
      `HelpModal`, `ThemePickerModal`, `FilterModal`, `SortModal`, `VerdictModal` and
      `ModalTabs` make their rows, tabs and list fields pointer targets.
- [x] 2.9 Make footer and modal key chips clickable in `StatusBar.tsx` and `HelpText.tsx`
      through one shared rule (a chip runs its command only when it is available and takes
      no argument), with no new hint text anywhere in a body, panel or empty state.
- [x] 2.10 Unit tests (`test/ui/mouseInteraction.test.ts`): tap vs drag (including a drag
      across rows), double-tap window and single activation, select-vs-activate resolution,
      unavailable/argument-taking chips, dismissal policy table (read-only vs guarded).
- [x] 2.11 Renderer tests (`test/dash/mouseInteraction.test.tsx`): tap selects; tap on the
      selected row activates; double tap activates once; tap on a border or empty area
      changes nothing; tap after a paged `onScroll` selects the visible row; drag over rows
      leaves selection and the copy handler untouched; wheel over an unfocused pane scrolls
      that pane only and changes no focus/selection.
- [x] 2.12 Renderer test: a modal's dialog box swallows taps (a tap inside does not reach
      the backdrop or a surface below) and a backdrop tap closes only a read-only dialog;
      a wizard/credentials/question dialog keeps its draft.
- [x] 2.13 Phase gate: `bun run lint`, `bun run type-check`,
      `bun test test/ui test/dash/sharedPrimitives.test.tsx test/dash/mouseInteraction.test.tsx test/dash/devenvUiPrimitives.test.ts`;
      the existing primitive tests stay unchanged and green.

## 3. Dashboard panels, modals and the agent session page

- [x] 3.1 Give each dashboard panel `onFocusRequest` so a tap focuses it via
      `setActivePanel`, gated by the same activity signals the keyboard uses, and attach
      `useWheelScroll` to the Change panel's scroll box (design D4, inventory rows 9–11).
- [x] 3.2 `OpenSpecPanel`, `ClassifierPanel`, `AgentsPanel`, `EvidencePanel`: pass `onSelect`
      and `onActivate` for their rows (select on tap, `Enter` action on a tap of the selected
      row) and keep the empty states unchanged (inventory rows 12–15).
- [x] 3.3 Verify the hidden panel grid cannot be tapped while the agent-session page is
      open (renderer test tapping where a grid row would be) (inventory row 9, design D4).
- [x] 3.4 `dash/modals/Overlays.tsx`: make the `ListViewModal` dialogs (repair target,
      completed-action picker, user action, plan rejection) activate on a tap of the selected
      row and focus their reason/field control on tap (inventory row 26).
- [x] 3.5 `WorkflowGraphModal`, `HelpModal`, `ThemePickerModal`, `VerdictModal`: wheel
      scrolling and the backdrop policy per design D5 (inventory rows 27–29, 31).
- [x] 3.6 `CostModal`, `FindingsModal`, `DebugRequestsModal`: row select, tap-on-selected
      activation, wheel on the detail/report pane, backdrop dismissal (inventory rows 23–25).
- [x] 3.7 `PresetSwitcherModal`: select on tap, switch only on an explicit activation,
      backdrop cancels (inventory row 21).
- [x] 3.8 `CredentialsModal` and `NumberEditor`: field focus on tap and clickable
      submit/cancel chips, with backdrop dismissal disabled (inventory rows 22, 37).
- [x] 3.9 `DeveloperQuestionModal`: option rows select, tap-on-selected picks that option,
      question `Tab` strip clickable, context pane wheel, submit/cancel chips clickable, no
      backdrop dismissal (inventory row 19).
- [x] 3.10 `NewWorkflowModal`: field taps focus the editor, option-list rows select and
      activate, `Next`/`Create`/`Back` chips clickable, backdrop dismissal disabled
      (inventory row 20).
- [x] 3.11 `AgentSessionView`: wheel on the transcript, tap focuses the prompt area, block
      row toggles kept, picker/filter lists select and activate, filter field focus on tap
      (inventory rows 17–18); keep selection copy intact.
- [x] 3.12 Review routes (`ReviewRoute`, `DialogueRoute`) and the review/comment dialogs:
      wheel scrolling and comment input focus on tap; typed-comment dialogs stay explicit
      (inventory row 30).
- [x] 3.13 Parity tests: for the dashboard panel list, the agents panel, a modal's option
      list and a modal's footer chip, assert the pointer and the key produce the same state
      (`test/dash/mouseNavigation.test.tsx`, `test/dash/modalMouse.test.tsx`).
- [x] 3.14 Phase gate: `bun run lint`, `bun run type-check`,
      `bun test test/dash` (the existing keyboard tests unchanged and green).

## 4. Orchestrator page (minimal, isolated)

- [x] 4.1 Change nothing in `src/tui/orchestrator/*` until `main` is rebased; then add wheel
      scrolling to the transcript and prompt focus on tap through the shared hook only
      (inventory rows 33–34), in a commit that touches nothing else.
- [x] 4.2 The Orchestrator model/thinking picker and history rows follow the shared
      list semantics (inventory row 35).
- [x] 4.3 Focused checks: `bun test test/orchestrator-monitor.test.ts test/dash/agentSessionView.test.tsx`
      plus a renderer test asserting the wheel scrolls the transcript and the prompt keeps
      its content.
- [x] 4.4 Confirm no key handling, session lifecycle or monitoring behavior changed by
      diffing the phase against the previous commit and reporting the diff in the handoff.

## 5. Settings

- [x] 5.1 `SettingsSectionView`: tap selects, a tap of the selected row runs the item action
      (theme picker, navigate, numeric editor, retry, browser install) and the wheel scrolls
      (inventory row 36).
- [x] 5.2 `NumberEditor`: field focus on tap, accept/cancel chips clickable, no backdrop
      dismissal (inventory row 37).
- [x] 5.3 `AgentPresetsView`: menu/list/pool rows select and activate on tap, text/select/
      number fields focus on tap, provider and install-prompt chips clickable, wheel on long
      lists, delete confirmation explicit-only (inventory row 38).
- [x] 5.4 Parity tests at the renderer boundary for a section row activation and a preset
      list row (`test/settings/mouseSettings.test.tsx`), and confirm scopes, saved values and
      validation messages are unchanged.
- [x] 5.5 Phase gate: `bun run lint`, `bun run type-check`, `bun test test/settings test/dash/keybindCatalog.test.tsx`.

## 6. Environments feature

- [x] 6.1 Apply the shared semantics to the tables and list views (`Table`,
      `IssueView`, `ChangeRequestView`, `JobsDetailView`, `TestResultsDetailView`,
      `KubernetesClusterView`): select on tap, detail on a tap of the selected row, wheel on
      the list (inventory row 40).
- [x] 6.2 Detail views and viewers (`*DetailView`, `ChangedFilesView`, `TimelineView`,
      `ReferencesView`, `DiscussionsView`, `DiffReviewView`, `MarkdownReviewView`,
      `LogModal`): wheel scrolling on every scroll pane; drag keeps selecting text
      (inventory rows 41, 56).
- [x] 6.3 Slot and action views (`slots-view`, `actions-view`, `action-run-modal`): row
      select/activate, log pane wheel, and no backdrop dismissal while a run is in flight
      (inventory row 42).
- [x] 6.4 Environment dialogs (`views/*`, `views/modal-overlays.tsx`): rows select and
      activate, tabs clickable, fields focus on tap, chips clickable, and the guarded kinds
      (passphrase, typed comment, close reason, confirmation, running progress) keep an
      explicit control instead of a backdrop dismissal (inventory row 43).
- [x] 6.5 `HelpView` guide rows select and open on tap (inventory row 45), and splashes stay
      non-interactive (inventory row 44).
- [x] 6.6 Renderer tests for one table, one detail pane and one guarded dialog
      (`test/ui/environmentMouse.test.tsx`); run the existing environment view tests to show
      they are unchanged.
- [x] 6.7 Phase gate: `bun run lint`, `bun run type-check`, `bun test test/ui test/dash/devenvUiPrimitives.test.ts`.

## 7. Observability, Wiki and shared navigation

- [x] 7.1 Observability lists and details: trace list (tap-on-selected opens, wheel pages),
      trace tree/span detail, metrics, logs (and remove the dead `onMouseUp` in
      `LogDetailView`), topology (inventory rows 46–50).
- [x] 7.2 Shell tabs, status bar and the search/filter/sort modals: tabs clickable, chips
      clickable, rows select and activate, filter field focus on tap (inventory rows 51, 53).
- [x] 7.3 Wiki tree and note modal: tap-on-selected opens, wheel on the note, note action
      chips clickable, comment submission explicit-only (inventory row 52).
- [x] 7.4 Shared navigation: destination pages activate on a tap of the selected row, the
      location picker keeps its accept-on-tap and gains wheel scrolling, the breadcrumb row
      keeps its navigate-on-tap through the shared rule (inventory rows 4–6).
- [x] 7.5 Toasts dismiss on tap through the notification store's existing dismiss path,
      never dismissing a toast that carries a required developer action (inventory row 7).
- [x] 7.6 Delete-workflow and trace confirmation modals: explicit confirm clickable, never a
      backdrop confirm (inventory row 54).
- [x] 7.7 Renderer tests across surfaces (`test/otel/mouseNavigation.test.tsx`) including one
      keyboard/pointer parity assertion per surface touched.
- [x] 7.8 Phase gate: `bun run lint`, `bun run type-check`,
      `bun test test/otel test/dash/panelNavigation.test.tsx`.

## 8. Documentation and validation

- [x] 8.1 Update `src/tui/dash/README.md` and `src/tui/shared/README.md` with the shared
      pointer layer, its primitives and the rule that surfaces never carry their own click
      resolution; keep the primitive/owner tables accurate.
- [x] 8.2 Update the TUI navigation and keybinding documentation for the mouse behavior it
      now has (including the deliberate non-goals: no hover, ignored right/middle click, no
      draggable scrollbars or splitters).
- [x] 8.3 State mouse parity once in the in-app help/hint text (the `?` help and modal
      footer), never as keybind cheat text inside a tab body, panel body, header or empty
      state.
- [x] 8.4 Update design.md's inventory with any item the implementation changed or added, so
      it matches the shipped surfaces.
- [x] 8.5 Final gate: `bun run lint`, `bun run type-check`,
      `bun test test/ui test/dash test/otel test/settings`, and
      `openspec validate tui-mouse-navigation --strict` plus
      `openspec validate --specs --strict`.

## Verifier round (second implementation attempt)

The verification round's findings are fixed in this change and recorded in
design.md's "Verifier round" section: the four dashboard pickers' backdrop now
dismisses instead of confirming, `GenericModal`'s backdrop is a real tap
(primary button, no drag, target-is-backdrop, `stopPropagation`) and fail-closed
for an unnamed kind, `MouseFocusArea` was replaced by `Panel.onFocusRequest` and
the new `useTap` binding (no raw `onMouseUp` remains on a control), the
`ScrollableList` gesture holder and wheel gate were added, `SlotsView` rows and
the missing parity tests landed, and the help modal's row contract is shared.
`grep -c '^- \[ \]' tasks.md` is 0.

### Second verifier round

Fixes for the second round's findings: the row gesture is keyed on the row index
(a recreated row still taps, another row never does), a repeat activation inside
the 400 ms window is inert, `useTap` consumes a nested control's tap
(trace-tree expander, sidebar mode glyphs), the diff/markdown anchors, the
dependency-tree rows (debug probe removed) and the provider rows now use the
shared bindings, the wheel is only swallowed by a pane that can act and the
evidence pane opts out of cursor movement, the trace-tree wheel is O(1) through
`onSelectIndex`, `modalHelp.ts` clamps on `helpModalRowCount`, and the
environment package gained a `@ui` re-export barrel for one import path, and the
fork guard that can actually fail is the new source assertion in
`test/ui/packageBoundaries.test.ts` (no local pointer-layer declaration under
`packages/devenv/**`, every pointer import from `@ui`). New/updated tests: `test/dash/mouseInteraction.test.tsx`
(the shipped `Overlays` backdrop tap cancels and never confirms),
`test/dash/panelPointer.test.ts`, `test/dash/keybindCatalog.test.tsx` and
`test/dash/modalHelp.test.tsx` (the shared help row contract and the `Mouse`
section being reachable), `test/ui/mouseInteraction.test.ts` (the wheel gate and
the row-keyed gesture), `test/dash/devenvUiPrimitives.test.ts` (two real
modules), and `test/otel/workspaceSidebar.test.tsx` (a right click and a drag on
the mode glyph change nothing).

### Third verifier round

Fixes: `ScrollableList` finally reads the wheel gate it documents (and
`wheelMovesCursor`), the diff/markdown row anchors use the shared tap rule, the
provider rows activate by dispatching the dialog's own `e` with real footer
chips, the dependency tree's leftover debug log is gone, `ReviewRoute`'s backdrop
is the review's own `Esc` ladder, the dangling doc comment in `modalHelp.ts` is
removed, `SlotsView` shares one gesture holder, and every site that copied two
handlers spreads the object (the third clears a press on pointer-leave). New
tests: the inert list inside a scroll box, `wheelMovesCursor={false}`, a release
on another row after a window move, a nested control consuming its tap, the modal
option-list parity (`test/dash/modalMouse.test.tsx`), the markdown review drag
(`test/ui/reviewMouse.test.tsx`), a replaced slot row completing its press, and
the environment-package fork guard in `test/ui/packageBoundaries.test.ts`.

### Fourth verifier round

Fixes: the theme picker's rows are pointer targets (its `onSelect` was declared
and dropped), a row index may be an accessor resolved per event (the agent
session view's autocomplete row no longer freezes its index), the help modal and
the workflow-graph dialog scroll under the wheel, the wiki tree's wheel moves its
cursor, the observability filter/sort dialogs and the task-arguments dialog
select their rows, and the lists that built a holder per row now share one.
Tests: `test/otel/traceTreeMouse.test.tsx` (the tree's wheel by index with
clamping, an empty tree swallowing nothing, the expander consuming its tap),
`test/ui/themePickerMouse.test.tsx`, the help modal's wheel (`test/dash/keybindCatalog.test.tsx`),
the accessor-index rule (`test/ui/mouseInteraction.test.ts`) and the review taps
asserting the line they received (`test/ui/reviewMouse.test.tsx`).

### Fifth verifier round

Fixes: the filter dialog's criteria row no longer borrows the value pane's
callback (each pane gates and reports its own selection, and the row's activation
is the dialog's own `Enter`), every environment filter/sort dialog and the
environment theme picker pass the store setters their key layer drives
(`ThemePickerView` gained `onSelectIndex`), the remaining frozen row indices
(`MetricsView`, `slots-view`, `SortModal`, `TaskArgsModal`) use the accessor form,
the task-arguments rows activate through `Enter` instead of re-selecting, the
trace tree's wheel box is always mounted so its `enabled` gate decides, and the
dead spy scaffolding in the new tests is removed. New coverage: the environment
filter dialog's row selection
(`test/ui/environmentMouse.test.tsx`), the trace tree's positive activation and
its empty-tree wheel reaching the scroll owner (`test/otel/traceTreeMouse.test.tsx`).

### Sixth verifier round

Fixes: a double tap is the same *row* (the tap record carries the row instance,
so two rows that encode index 0 are never each other's double tap); a synthesized
chip stroke carries the sequence a real keypress carries (Space and printable
single strokes), so the environment's sequence-matching handlers run; the
activation stroke is a surface property (`activateKey`, default `Enter`; the
environment's filter/sort dialogs pass `Space`, which is what applies there); and
a tap in the task-arguments dialog focuses that pane (`onFocusPane`). Tests: the
cross-row double-tap rule and the same-row inert repeat
(`test/ui/mouseInteraction.test.ts`), a Space chip reaching a sequence-matching
handler (`test/dash/mouseInteraction.test.tsx`), the environment filter dialog's
apply key (`test/ui/environmentMouse.test.tsx`) and the environment theme
adapter's forwarded selection (`test/ui/themePickerMouse.test.tsx`).
