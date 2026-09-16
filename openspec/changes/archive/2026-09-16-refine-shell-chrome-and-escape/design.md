# Design: Escape ladder, modal order and chrome ownership

## 1. One Escape ladder

Escape is handled in exactly one place: an ordered list of levels at the top of
the shell dispatcher (`otel/app/App.tsx`). Each level returns `true` when it
consumed the key; the first `true` wins. Levels are innermost → outermost:

| # | Level | Today | Action on Escape |
| --- | --- | --- | --- |
| 1 | Global error modal | inline, top | dismiss |
| 2 | Quit confirmation | inline, top | answer "no" |
| 3 | Modal help over a dialog (`modalHelpOpen`) | inline | close help only |
| 4 | Contextual workflow wizard | its own handler | one wizard step back; cancel on the first step |
| 5 | Top shell modal (locations, help, theme, filter, sort) | `nav.esc()` + per-modal branches | the modal's own inner level first (e.g. clear the theme filter), else close the modal |
| 6 | Breadcrumb focus | inline | return focus to the page body |
| 7 | Text-input mode (traces/logs search) | inline, **below** the dead hierarchy step | cancel the input, restore the previous query |
| 8 | Page hierarchy | `pages.back()` when `canBack()` | `pages.goToParent()`; no-op at Home |

Rules:

- Levels 6 and 7 are focus/input levels *inside* the current page, so they run
  before the hierarchy step and after every overlay.
- A modal that owns Escape owns it completely: the environment feature's own
  dialogs stay with the feature (its keymap layers are higher priority and the
  shell never pops the mirrored `environment` entry), the wizard steps stay with
  the wizard.
- Fixing the ordering is part of the work: level 7 currently sits *below* the
  hierarchy step, so Escape in a search box navigates away instead of cancelling.
- Escape at Home stays a no-op (Home has no structural parent) and never quits.

## 2. Parent vs Back vs Forward

| Operation | Key | Equivalent (any terminal) | Source |
| --- | --- | --- | --- |
| Parent (structural up) | `Esc` | `Alt+Up` | `parentRoute(route)` from the page catalog |
| Back (chronological) | `Ctrl+O` | `Alt+Left` | history stack |
| Forward (chronological) | `Ctrl+I` | `Alt+Right` | new forward stack |

- `RouterState` gains `forward: Route[]`. `navigate()` clears it (a new move
  invalidates the forward branch, as in vim); `back()` pushes the current
  location onto it; `forward()` pops it. `goToParent()`/`replace()` keep their
  current semantics.
- `Ctrl+I` is currently folded into `Tab` (`const isCtrlTab = event.ctrl && key === "i"`).
  That alias is a defect for this change and is deleted: `Tab`/`Shift+Tab` keep
  page-local focus cycling, `Ctrl+I` is Forward.
- Because `Ctrl+I` and `Tab` are the same byte on terminals without the kitty
  keyboard protocol (the shell renderer enables `useKittyKeyboard: {}`, so
  kitty/wezterm/ghostty/iTerm2 do distinguish them), Forward is *also* bound to
  `Alt+Right` and Back to `Alt+Left`. Both arrive as distinct escape sequences
  everywhere, including legacy terminals, so no journey depends on the protocol.
  `alt+left`/`alt+right` are unbound in the shell and in the environment feature
  today, so this adds no conflict.
- Per-view `escape || b` back-alias branches (`otel/app/App.tsx` traces/logs/
  metrics/topology) are deleted; the two unused `onBack` props
  (`MetricDetailView`, `LogDetailView`) go with them.
- The wiki note-close and metric/log detail "up" paths call `goToParent()`
  instead of `back()`, so every "leave this page" key is the same operation.

## 3. Environment feature must yield at its navigation root

Inside `packages/devenv/cli/src/tui`:

- `keyboard/table-keys.ts`, `case "escape"`: keep "clear an active search first",
  then, when `!appStore.canGoBack()` (the store view stack is at its root), return
  `false` instead of `resetViewStack("table")`. Not consumable → the key falls
  through the Global layer (its `escape` binding is `fallthrough: true`) to the
  shell layer, which performs the hierarchy step.
- Deeper view modes are unchanged: the feature pops its own view stack one level
  and reports the destination, which is the same up-step.
- The shell must not close the mirrored `environment` modal entry itself
  (`otel/app/navigation.ts` `esc()`): that entry belongs to the feature's own
  report. This removes a desync where the shell popped its mirror while the
  feature's dialog stayed open.

## 4. Modal order is open order, not flag order

`keyboard/keymap-runtime.ts` resolves the active modal from a **hard-coded
boolean list** (`getOpenModalNames`), and `handleGlobalKeys` re-checks the same
flags in the same fixed order. A dialog opened *from* another dialog therefore
loses Escape whenever it ranks lower in that list.

- Keep one ordered registry of open dialog names. The lowest-churn version: keep
  a previous snapshot in the runtime, and on each sync append names that became
  true in the order they appeared and drop names that became false. The result is
  `openModals` in open order, so `openModals.at(-1)` is genuinely the newest.
- `getActiveModalName` keeps preferring the store's own stack (`appStore.modalStack`)
  when it agrees with that list — the store stack already records open order and
  is the authority for `actions`/`branch`.
- `handleGlobalKeys` dispatches the *top* modal first (switch on the active name)
  and only falls back to the current fixed order when no dialog is open. Parent
  flags then cannot win over the child that is on top.
- Every dialog kind that can hold input needs a layer or an explicit branch:
  `modal-keymap-layers.ts` has no layer for `comment`, which today means the
  shell layer receives Escape while a comment dialog is visible.

Shell-side nesting (location picker over filter, `?` help over any dialog,
picker/wizard over the environment dialog) already works through
`shared/modalStack.ts`; the work here is to keep it the only ordering authority
and to prove it with tests.

## 5. Chrome ownership

**Rule: a row may render a page's name only when no breadcrumb row names that
page, and no chrome row advertises keybinds.**

Consequences applied to every surface (full audit in `inventory.md`):

- Shell pages: the destination/settings title row, the description row and the
  spacer row are removed; the list starts on the line under the breadcrumb.
- Observability view headers: the echoed page name is dropped, the data in the
  same row (counts, service, duration, status, timestamp) stays, and in-page
  section headers ("Attributes", "Body", "Data points") stay.
- Embedded environment views: the identity row of a list/detail header is
  suppressed while the shell chrome is present; standalone `devenv` (no
  breadcrumb) keeps it. Implemented as one shared gate, not per-view props:
  a module-level signal in `@devenv/ui` (same shape as the existing
  `shared/keybinds.ts` store) that the embedded feature sets once and each
  identity row reads. Feature content may not import shell modules.
- Standalone environment header: identity and status stay (no breadcrumb exists
  there), the `? help` / `? close` hint text is removed because the footer and
  the `?` help modal already own that.
- Modal hint text ("Enter opens · Esc closes" in the location picker) moves to the
  shared `HelpText` modal footer contract instead of a bespoke row.
- Breadcrumb labels: `pageLabel()` gains resource naming for
  `observability.logs.detail`, `observability.metrics.detail`,
  `observability.traces.tree`, `observability.traces.tree.span`, `wiki.note` and
  `workflows.detail`, reusing the existing `environments.resource` approach with
  a width bound so a long identity cannot push the row past the terminal width.

## 6. Chrome line budget (defect)

`views/content-router.tsx` subtracts `LAYOUT_CHROME_LINES` (5 = the feature's own
2-line header + 3-line footer) unconditionally, although in embedded mode the
shell renders the chrome and the feature renders neither. Every embedded
environment list is therefore five rows shorter than the space it occupies.

The reservation becomes a value the shell owns: the shell publishes its chrome
height (now 2 lines: logo bar + breadcrumb; 0 for a surface that renders no
chrome) into the feature, and the embedded view uses that instead of the
standalone constant. Same check for the `ScrollableList` `reservedLines`
consumers, which repeat the constant. Standalone `devenv` keeps
`LAYOUT_CHROME_LINES` unchanged, so its layout is untouched.

Validation: assert rendered table height at a fixed terminal size in embedded
and standalone mode, so the two do not drift again.

## 7. Non-goals

- No router framework, no new dependency, no changes to route identities, stored
  history, backend payloads or the dashboard's panel navigation.
- No removal of data-bearing status/detail rows anywhere.
- `agentic-coding dash` keeps its own header (workflow change/phase/branch/updated
  data) and its own panel keybinds; its fix is limited to removing keybind hint
  text from chrome if any survives the audit.
