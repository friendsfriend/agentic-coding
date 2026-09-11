# Shared TUI primitives (`src/tui/shared/`)

Consolidated single implementations for behavior that is genuinely equivalent
across the dashboard (`src/tui/dash/ui`), devenv (`src/tui/dash/devenv-ui`),
and observability (`src/tui/otel`) surfaces. Shared modules depend only on
OpenTUI, Solid, the theme data in `src/tui/themes`, and each other — never on
a dashboard or observability feature module.

## Owners

| Primitive | Single implementation | Family entry points |
| --- | --- | --- |
| Theme store & theme-sourced colors | `theme.ts`, `colors.ts` | `dash/ui/theme.ts`, `dash/ui/colors.ts`, `dash/devenv-ui/colors.ts`, `otel/ui/theme.ts`, `otel/ui/colors.ts` |
| Global selection mouse-up registry | `selectionCopy.ts` | `dash/selectionCopy.ts`, `dash/devenv-ui/selectionCopy.ts` |
| Highlight type/color mapping | `Highlight.tsx` | `dash/ui/Highlight.tsx`, `dash/devenv-ui/components/Highlight.tsx`, `otel/components/Highlight.tsx` |
| Scroll wrapper | `ScrollableContent.tsx` | `dash/ui/ScrollableContent.tsx`, `dash/devenv-ui/components/ScrollableContent.tsx`, `otel/components/ScrollableContent.tsx` |
| Selection rows/list | `Selectable.tsx` | `dash/ui/Selectable.tsx`, `otel/components/Selectable.tsx` |
| Portaled modal framing | `GenericModal.tsx` | `dash/ui/GenericModal.tsx`, `dash/devenv-ui/components/GenericModal.tsx` |
| Search header, filter/sort row, help text | `SearchHeader.tsx`, `FilterStatusBar.tsx`, `HelpText.tsx` | `dash/devenv-ui/components/*` |
| Keybind contract, catalog store, `?` help modal | `keybinds.ts`, `HelpModal.tsx` | `dash/ui/HelpModal.tsx` |
| Modal `?` help catalog + overlay | `modalHelp.ts`, `ModalHelpOverlay.tsx` | (surfaces render `ModalHelpOverlay`) |
| Corner toast overlay | `Notification.tsx` | `dash/ui/Notification.tsx`, `otel/components/Notification.tsx` |

Family entry points are thin re-exports/wrappers. Wrappers pin a family's
legacy defaults (scrollbar colors, `focusable`, dialog background alpha,
backdrop-click propagation, otel highlight default); they never re-implement
the primitive.

## Retained variants (intentional differences)

- `otel/components/GenericModal.tsx` — embedded modal with no portal, no
  backdrop click handling, and its own SearchHeader/FilterStatusBar/Help
  footer. z-order and input ownership differ from the portaled modals, so it
  stays a separate implementation per the consolidation design.
- `dash/ui/Badge.tsx`, `dash/devenv-ui/components/Badge.tsx`,
  `otel/components/Badge.tsx` — animated powerline badge vs. simple text
  badge; animation/lifecycle and rendering differ, so each stays.
- `dash/ui/animationColors.ts`, `dash/devenv-ui/components/animationColors.ts`
  — belong to the retained animated badge.
- `otel/components/StatusBar.tsx` — the only live status bar (dashboard copy
  was dead and removed).
- `otel/components/SearchHeader.tsx`, `otel/components/FilterStatusBar.tsx`
  — observability view-header row contracts (accessor props, auto-hide,
  always-shown result count; label-based filter/sort layout).

## Conventions

- Keybind help is data-driven and rendered by the footer plus the `?` help
  modal. Every entry is a `Keybind` (`keybinds.ts`) declared once in a
  per-surface catalog; the shell footer (`otel/components/StatusBar.tsx`)
  stays one row high, clipping the special keys in its left column while
  pinning `?` help to the right, the shared `?` help modal
  (`shared/HelpModal.tsx`) renders the whole catalog, and dialogs render
  through `HelpText` / `formatHelpTextLines` with a single space either side
  of the `•` separator. Feature views (tab bodies, panel headers, empty and
  error states) must not print their own keybinding lists or single "press
  key" prompts.
- Modals reuse the same contract: a dialog that passes keybind `help` gets a
  `? help` entry appended to its footer and publishes its catalog through
  `modalHelp.ts`. The owning surface routes `?`/`j`/`k`/`Esc` to
  `handleModalHelpKey` and renders `ModalHelpOverlay`, which draws the shared
  `HelpModal` above the dialog. Dialogs where `?` must stay a text key (or
  that never route modal help) pass `helpSections={false}`, which suppresses
  both the advertised `? help` entry and the catalog registration so the
  footer never promises a dead key. The overlay lives beside `GenericModal`
  (not inside it) so the modal shell and help modal do not form a runtime
  import cycle.

## Behavior notes

- Consolidating the selection-copy registries made the single shared registry
  live for every modal path: devenv modal dialog clicks now invoke the global
  copy handler the shell registers (previously devenv's private registry was
  never set, so those clicks were no-ops). This is the cross-surface parity
  the consolidation intends, not a regression.
- The legacy dash `search` prop maps to the display-only "/ <query>" header
  (no trailing input cursor), matching the removed dash SearchHeader. The
  live `█` cursor renders only when a caller explicitly passes `searchMode`
  (the devenv live-search header contract).
- Summary tables shrink side-by-side on narrow dialogs (content column keeps
  a floor while the table scales down) and stack full-width below the content
  when the dialog is too small for a usable side-by-side layout, so neither
  content nor the summary becomes inaccessible at half-split widths.
- The progress-bar animation effect is gated to modals that actually render
  the bar (`step` provided); other modal opens start no animation timer.