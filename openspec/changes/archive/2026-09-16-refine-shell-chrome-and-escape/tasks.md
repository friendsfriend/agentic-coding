# Tasks: Refine shell page chrome and the Escape ladder

## 1. Escape ladder

- [x] 1.1 Collect the Escape handling of `src/tui/otel/app/App.tsx` into one ordered ladder (levels 1–8 in `design.md` §1) with a single entry check at the top of `handleKey`; each level returns whether it consumed the key.
- [x] 1.2 Move the text-input level above the page level (traces/logs search cancel now unreachable while history exists) and keep breadcrumb-focus defocus in front of it.
- [x] 1.3 Delete the per-view `escape || b` back branches in the traces tree, logs, metrics and topology handlers and the unused `onBack` props on `MetricDetailView` / `LogDetailView` (plus their `App.tsx` call sites).
- [x] 1.4 Replace the `pages.back()` calls that mean "up" (wiki note close, metric/log detail) with `pages.goToParent()`, so every leave-page key is one operation.
- [x] 1.5 Restrict `createNavigation().esc()` (`otel/app/navigation.ts`) to shell-owned overlay kinds: the mirrored `environment` entry is owned by the feature's own report and is never popped by the shell.
- [x] 1.6 Test in `test/app/renderedNavigation.test.tsx`: Escape steps `Applications → Environments → Home` one level per press and is a no-op at Home; Escape inside an open modal closes only the modal and leaves the page unchanged.

## 2. Back / Forward on Ctrl+O / Ctrl+I

- [x] 2.1 Add `forward: Route[]` to `RouterState` in `src/tui/shared/routes.ts`; `navigate()` clears it, `back()` pushes the current location onto it, `forward()` pops it; expose `canForward()` and both operations through `createPageNavigation`.
- [x] 2.2 Bind `ctrl+o`/`alt+left` (back) and `ctrl+i`/`alt+right` (forward) in `dash/keymap-setup.ts` `SHELL_KEYS` and dispatch them in the ladder's outermost shell level.
- [x] 2.3 Delete the `Ctrl+I == Tab` alias in `handleKey` (defect: it would turn Forward into focus cycling); keep `Tab`/`Shift+Tab` focus cycling and rely on `Alt+Right`/`Alt+Left` where the terminal reports `Ctrl+I` as `Tab`.
- [x] 2.4 Extend `test/app/routes.test.ts` and `test/app/routeState.test.tsx` with forward-after-back, forward cleared by a new move, and cross-domain back/forward pairs.
- [x] 2.5 Add a keymap-level test that `ctrl+i` no longer resolves to the tab command and that `alt+right`/`alt+left` reach Back/Forward.

## 3. Feature yields Escape at its navigation root

- [x] 3.1 In `packages/devenv/cli/src/tui/keyboard/table-keys.ts`, return `false` from `case "escape"` when no search query is active and `!appStore.canGoBack()` (today: a no-op `resetViewStack("table")` that swallows the key), keeping the search-clear behaviour first.
- [x] 3.2 Confirm the key then falls through the Global layer (`escape` binding is `fallthrough: true`) to the shell layer, and add a feature test asserting Escape at table root is not consumed while a deeper view mode still pops one level.

## 4. Modal order is open order

- [x] 4.1 Replace the hard-coded boolean order in `packages/devenv/cli/src/tui/keyboard/keymap-runtime.ts` (`getOpenModalNames`) with an open-order list (append names that became true, drop names that became false), keeping `appStore.modalStack` as the authority when it agrees.
- [x] 4.2 Dispatch `handleGlobalKeys` from the top modal name first, falling back to the existing fixed order only when no dialog is open.
- [x] 4.3 Give every input-holding dialog kind a handler: add the missing `comment` kind to `modal-keymap-layers.ts` (today Escape reaches the shell layer while a comment dialog is visible) and check the remaining kinds in `getOpenModalNames` against the layer list.
- [x] 4.4 Extend `modal-stack-runtime.test.ts` / `modal-keymap-layers.test.ts`: parent dialog spawns child → first Escape closes only the child, second Escape closes the parent; shell-side nesting (location picker over the filter modal, `?` help over a dialog) keeps working through `shared/modalStack.ts`.

## 5. Chrome: remove duplicated identity rows

- [x] 5.1 `src/tui/shared/navigation/DestinationPage.tsx`: delete the title row, the description row and the spacer box; drop the `title`/`description` props and simplify the `HomePage`/`CategoryPage` wrappers; update the `App.tsx` call site and delete `destinationTitle()`.
- [x] 5.2 `src/tui/settings/SettingsSectionView.tsx`: delete the title and description rows and their props; update the `App.tsx` call site (the strings stay as destination-row descriptions).
- [x] 5.3 Observability views: drop the echoed page name in `TraceListView`, `MetricsView`, `LogsView`, `SpanDetailView`, `MetricDetailView`, `LogDetailView` and `ServiceDetailView` per `inventory.md`, keeping data columns, data subtitles and in-page section headers.
- [x] 5.4 Add the shared identity gate in `packages/devenv/ui` (module-level signal, set once by the embedded feature) and apply it to the identity rows listed in `inventory.md`; standalone rendering is unchanged.
- [x] 5.5 Standalone environment header: remove the `? help` / `? close` hint text from `header-helpers.ts` / `Header.tsx`; keep title, context and detail.
- [x] 5.6 `shared/navigation/LocationPicker.tsx`: remove the bespoke `Enter opens · Esc closes` row and route the modal footer through `HelpText`.
- [x] 5.7 Defect — chrome line budget: publish the shell's chrome height into the embedded feature (0 lines for a chrome-less surface, 2 for the current logo bar + breadcrumb) and stop subtracting `LAYOUT_CHROME_LINES` in `views/content-router.tsx` when embedded; thread it through `views/types.ts` and `app-opentui.tsx`.
- [x] 5.8 Defect follow-up: audit the `ScrollableList` `reservedLines` consumers that repeat the constant and use the published chrome height; assert rendered table height at a fixed terminal size in embedded and standalone mode.

## 6. Breadcrumbs name the resource

- [x] 6.1 Extend `pageLabel()` in `src/tui/shared/routes.ts` so `observability.logs.detail`, `observability.metrics.detail`, `observability.traces.tree`, `observability.traces.tree.span`, `wiki.note` and `workflows.detail` render their resource identity, bounded so the row cannot overflow (reuse the `environments.resource` approach).
- [x] 6.2 Extend `test/app/routes.test.ts` and the breadcrumb layout tests for resource labels, truncation and narrow-width collapsing.

## 7. Catalogs, help and docs

- [x] 7.1 Update every catalog in `inventory.md` ("Keybind surfaces to update"): `Esc` = up, `Ctrl+O`/`Alt+Left` = back, `Ctrl+I`/`Alt+Right` = forward, `Alt+Up` stays an alias, and the removed `b` alias disappears everywhere.
- [x] 7.2 Verify in the TUI at narrow and wide widths that the footer advertises the new keys for the active surface/panel and that `?` help lists every keybind including the standard ones; no keybind cheat sheet appears inside tab content, panel bodies or headers.
- [x] 7.3 Update `openspec/tui-navigation-roadmap.md` verification wording (Esc = Parent, `Ctrl+O`/`Alt+Left` = Back, `Ctrl+I`/`Alt+Right` = Forward) and any affected design note under `agentic-coding/docs/`.

## 8. Validation

- [x] 8.1 `openspec validate refine-shell-chrome-and-escape --strict`.
- [x] 8.2 `bun run test`, `bun test packages/devenv`, `bun run type-check`, `bun run lint` (zero diagnostics) from `agentic-coding/`.
- [x] 8.3 Manual journeys: Home → Environments → Applications → resource → Escape chain back to Home; open a dialog from a dialog and confirm one Escape per level; `Ctrl+O`/`Ctrl+I` and `Alt+Left`/`Alt+Right` across a feature boundary; Escape in a search box cancels the search; check the footer and `?` help on Home, an observability detail page and an embedded environment list.
- [x] 8.4 Confirm on a terminal both with and without the kitty keyboard protocol that `Tab` still cycles focus, Forward works, and the embedded environment table fills the rows the shell leaves it.
