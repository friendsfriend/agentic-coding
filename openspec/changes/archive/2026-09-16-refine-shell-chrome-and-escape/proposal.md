# Refine shell page chrome and the Escape ladder

## Why

Defects in the page-based shell (follow-up to
`replace-nested-tabs-with-page-navigation` and `compose-unified-feature-shell`):

1. **Escape means the wrong thing.** On a page it performs chronological Back
   (`pages.canBack() → pages.back()`), not the structural up-step the user
   expects (`Home › Environments › Applications` → `Environments`). Inside the
   embedded environment body Escape never reaches the shell at all: the feature's
   table handler consumes it (`resetViewStack("table")` is a no-op at the table
   root), so `Esc` on the Applications page does nothing. A second defect hides
   inside the same block: the Escape block sits *above* the search-input branch,
   so Escape cancels a page instead of the search box whenever history exists.
   Modal priority is a fixed flag order in the feature runtime
   (`keyboard/keymap-runtime.ts`), so with a parent dialog open a child dialog
   cannot reliably own Escape.
2. **Page chrome repeats itself.** Every page renders the page name twice — once
   in the breadcrumb, once in a title row — plus a description/hint row that
   advertises keybinds (`Choose a destination. Ctrl+P jumps anywhere.`) although
   one shared footer already does that. The name+description rows are the two
   lines to remove; the breadcrumb row takes over naming the location.
3. **`Ctrl+I` is aliased to `Tab`.** `handleKey` folds `ctrl+i` into the tab
   branch, so the vim jump-list Forward key would silently do focus cycling. The
   alias is removed and history Forward gets a terminal-independent binding pair,
   because a terminal without the kitty keyboard protocol delivers `Ctrl+I` as
   the same byte as `Tab`.
4. **The embedded feature reserves chrome it does not render.**
   `views/content-router.tsx` subtracts `LAYOUT_CHROME_LINES` (its own 2-line
   header + 3-line footer) unconditionally, although in embedded mode the shell
   renders the chrome — the shell's own `visible`-hidden body was already
   mounted and paying for it, so every embedded environment list loses five rows
   of table height. The reservation becomes a chrome height the shell publishes
   and the feature no longer guesses.

## What Changes

- **Escape is the structural up-step, always.** One ordered Escape ladder in the
  shell dispatcher: errors/quit guard → modal help → form step → top modal →
  breadcrumb focus → text-input mode → page hierarchy. Escape at Home stays a
  no-op; Escape never quits.
- **Chronological history moves to `Ctrl+O` / `Ctrl+I`** (vim jump list), so
  Back and Forward stay available without competing with the hierarchy step. The
  router gains a forward stack; `Ctrl+I` stops being treated as `Tab`.
- **The embedded environment feature yields Escape at its navigation root**, so
  the shell's hierarchy step runs for the category pages it delegates to.
- **Modal input order becomes open order.** The feature's modal dispatch and its
  keymap-layer gate resolve from one ordered stack instead of a hard-coded
  boolean list, so `Esc` closes exactly the newest dialog, one level per press.
- **Chrome rule: a page's identity rows are removed wherever a breadcrumb already
  names that page, and no chrome row advertises keybinds.** Applies to the shell
  destination/settings pages, the observability view headers, the embedded
  environment view headers and the standalone environment header.
- **Breadcrumb segments name the resource** for resource pages (log, metric,
  span, trace, note, workflow), which is what makes the removed title rows
  redundant instead of lossy.
- **`Ctrl+I` stops meaning `Tab`**: Back and Forward are `Ctrl+O`/`Ctrl+I` with
  `Alt+Left`/`Alt+Right` as equivalents that work on every terminal.
- **Chrome line budget becomes explicit** for the embedded feature: it stops
  reserving header/footer lines the shell renders, and the shell publishes its
  actual chrome height instead.

## Capabilities

### Modified Capabilities

- `hierarchical-tui-navigation`: Escape is the structural Parent step; Back and
  Forward are `Ctrl+O`/`Ctrl+I`; one ordered Escape ladder owns level priority;
  breadcrumb segments name the rendered resource.
- `unified-feature-shell`: modal input order is dialog open order across shell
  and feature dialogs; the shared chrome (logo bar + breadcrumb) is the only
  place a page is named, and it advertises no keybinds.
- `tui-shared-primitives`: identity rows in shared/list headers render only when
  no shell chrome names the page; primitives never carry keybind hint text.

## Impact

- `agentic-coding/src/tui/shared/routes.ts` — forward stack, `canForward`,
  resource-naming `pageLabel`.
- `agentic-coding/src/tui/otel/app/App.tsx` — one Escape ladder, `Ctrl+O`/`Ctrl+I`
  bindings, `Ctrl+I`-as-Tab removal, chrome rows removed, `onBack` prop plumbing.
- `agentic-coding/src/tui/shared/navigation/{DestinationPage,BreadcrumbRow,LocationPicker}.tsx`,
  `agentic-coding/src/tui/shared/SearchHeader.tsx`,
  `agentic-coding/src/tui/settings/SettingsSectionView.tsx`,
  `agentic-coding/src/tui/otel/views/*` — identity rows removed, data rows kept.
- `agentic-coding/src/tui/otel/app/keybinds.ts`,
  `agentic-coding/src/tui/shared/navigation/keybinds.ts`,
  `agentic-coding/src/tui/settings/state.ts`, `agentic-coding/src/tui/dash/keymap-setup.ts`
  — bindings and footer/help projections.
- `agentic-coding/packages/devenv/cli/src/tui/keyboard/{table-keys,keymap-runtime,global-keys}.ts`,
  `views/content-router.tsx`, `views/types.ts`, `app-opentui.tsx` — Escape yield,
  modal order, published chrome height replacing `LAYOUT_CHROME_LINES`.
- `agentic-coding/packages/devenv/ui/src/components/*` — identity-row gate for
  embedded rendering.
- Tests under `agentic-coding/test/app/` plus the feature's keyboard/store tests.
  No backend, route-data or storage change.
