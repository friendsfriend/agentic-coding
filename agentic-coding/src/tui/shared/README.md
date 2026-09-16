# Shared TUI primitives (`src/tui/shared/`)

Consolidated single implementations for behavior that is genuinely equivalent
across the dashboard (`src/tui/dash/ui`), the environment surface
(`packages/devenv/ui`, reused by `packages/devenv/cli`), the devenv fork
(`src/tui/dash/devenv-ui`), and the observability surface (`src/tui/otel`).
Shared modules depend only on OpenTUI, Solid, the theme data in
`src/tui/themes`, and each other — never on a dashboard, environment, or
observability feature module.

## Owners

| Primitive | Single implementation | Family entry points |
| --- | --- | --- |
| Theme store & theme-sourced colors | `theme.ts`, `colors.ts` | `dash/ui/theme.ts`, `dash/ui/colors.ts`, `dash/devenv-ui/colors.ts`, `otel/ui/theme.ts`, `otel/ui/colors.ts`, `packages/devenv/ui/{theme,colors}.ts` |
| UI preferences: canonical `tui.json`, one-time legacy import, atomic saves, custom-theme loading | `preferences.ts` | `dash/theme-settings.ts`, `packages/devenv/cli/src/tui/theme-settings.ts` |
| Renderer palette capture (`renderer.getPalette`) + `system` ThemeJson mapping | `terminal-theme.ts` | `dash/ui/terminal-colors.ts`, `packages/devenv/cli/src/tui/theme-settings.ts` |
| Global selection mouse-up registry | `selectionCopy.ts` | `dash/selectionCopy.ts`, `dash/devenv-ui/selectionCopy.ts`, `packages/devenv/ui/selectionCopy.ts` |
| Highlight type/color mapping | `Highlight.tsx` | `dash/ui/Highlight.tsx`, `dash/devenv-ui/components/Highlight.tsx`, `otel/components/Highlight.tsx`, `packages/devenv/ui/components/Highlight.tsx` |
| Search-match text | `MatchedText.tsx` | `dash/devenv-ui/components/MatchedText.tsx`, `packages/devenv/ui/components/MatchedText.tsx` |
| Centered empty/loading/error state | `CenteredState.tsx` | `dash/devenv-ui/components/CenteredState.tsx`, `packages/devenv/ui/components/CenteredState.tsx` |
| Panel/content framing | `ContentStack.tsx` | `dash/devenv-ui/components/ContentStack.tsx`, `packages/devenv/ui/components/ContentStack.tsx` |
| Virtualized list + scroll math | `ScrollableList.tsx`, `utils/virtualScroll.ts`, `utils/focusSoon.ts` | `dash/devenv-ui/components/ScrollableList.tsx`, `packages/devenv/ui/components/ScrollableList.tsx` |
| Scroll wrapper | `ScrollableContent.tsx` | `dash/ui/ScrollableContent.tsx`, `dash/devenv-ui/components/ScrollableContent.tsx`, `otel/components/ScrollableContent.tsx`, `packages/devenv/ui/components/ScrollableContent.tsx` |
| Selection rows/list | `Selectable.tsx` | `dash/ui/Selectable.tsx`, `otel/components/Selectable.tsx` |
| Portaled modal framing | `GenericModal.tsx` | `dash/ui/GenericModal.tsx`, `dash/devenv-ui/components/GenericModal.tsx`, `packages/devenv/ui/components/GenericModal.tsx` |
| Markdown rendering (whole document + per-block) and syntax style | `MarkdownViewer.tsx`, `markdownSyntax.ts`, `markdownBlocks.ts` | `dash/devenv-ui/components/MarkdownViewModal.tsx`, `dash/devenv-ui/markdownBlocks.ts`, `packages/devenv/ui/components/MarkdownModal.tsx`, `packages/devenv/ui/markdownSyntax.ts` |
| Diff line/split model | `diffView.ts` | `dash/devenv-ui/components/DiffViewModal.tsx`, `packages/devenv/ui/components/DiffViewModal.tsx` |
| Log rendering | `LogView.tsx` | `packages/devenv/ui/components/LogView.tsx` |
| Theme picker | `ThemePicker.tsx` | `dash/ui/ThemePickerModal.tsx`, `otel/components/ThemePickerModal.tsx`, `packages/devenv/ui/components/ThemePickerView.tsx` |
| Search header, filter/sort row, help text | `SearchHeader.tsx`, `FilterStatusBar.tsx`, `HelpText.tsx` | `dash/devenv-ui/components/*`, `packages/devenv/ui/components/*` |
| Animated badge variant, animation palettes, inline progress, animated status text | `Badge.tsx`, `animationColors.ts`, `InlineProgressAnimation.tsx`, `AnimatedStatusText.tsx` | `dash/ui/animationColors.ts`, `dash/devenv-ui/components/*`, `packages/devenv/ui/components/*` |
| Keybind contract, catalog store, `?` help modal | `keybinds.ts`, `HelpModal.tsx` | `dash/ui/HelpModal.tsx` |
| Modal `?` help catalog + overlay | `modalHelp.ts`, `ModalHelpOverlay.tsx` | (surfaces render `ModalHelpOverlay`) |
| Corner toast overlay | `Notification.tsx` | `dash/ui/Notification.tsx`, `otel/components/Notification.tsx` |

Family entry points are thin re-exports/wrappers. Wrappers pin a family's
legacy defaults (scrollbar colors, `focusable`, dialog background alpha,
backdrop-click propagation, otel highlight default); they never re-implement
the primitive. `test/dash/devenvUiPrimitives.test.ts` asserts the environment
entry points are the same function objects as the shared implementations and
that the theme store is one instance across surfaces.

## Retained variants (intentional differences)

- `otel/components/GenericModal.tsx` — embedded modal with no portal, no
  backdrop click handling, and its own SearchHeader/FilterStatusBar/Help
  footer. z-order and input ownership differ from the portaled modals, so it
  stays a separate implementation per the consolidation design.
- `dash/ui/Badge.tsx`, `otel/components/Badge.tsx` — dashboard powerline badge
  API and observability's simple text badge differ in animation/lifecycle and
  rendering; the environment/devenv-fork animated variant is shared
  (`shared/Badge.tsx`).
- `otel/components/StatusBar.tsx` — the only live status bar (dashboard copy
  was dead and removed).
- `otel/components/SearchHeader.tsx`, `otel/components/FilterStatusBar.tsx`
  — observability view-header row contracts (accessor props, auto-hide,
  always-shown result count; label-based filter/sort layout).
- Feature review modals (`DiffViewModal`, `MarkdownViewModal`) remain per-surface
  wrappers around the shared `diffView` model and `MarkdownViewer`/block
  renderers: they own provider positions, review/comment anchors, source-range
  and finding callbacks, which design decision 6 keeps outside the shared
  renderer. For logs there is one implementation: the environment `LogModal`
  (search + AI overlay) renders its own lines and composes the shared frame,
  `SearchHeader` and `ScrollableContent`; the shared `LogView` is the generic
  scrollable log renderer exported for reuse and has no duplicate to replace.

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

- One theme registry and one preference adapter: the canonical file is
  `$AGENTIC_CODING_CONFIG_DIR/tui.json` (default
  `~/.config/agentic-coding/tui.json`). A
  missing canonical selection imports the legacy agentic-coding `[ui] theme`
  once, preserving unrelated keys; writes are atomic and a failed save leaves
  the previous file intact. `system` is reserved for a successful renderer
  palette capture.
- Renderer palette capture goes through the OpenTUI renderer palette API with
  a bounded timeout. A timeout, a failed query, a missing API, or a headless
  run registers no `system` theme; there is no manual OSC input reader. A
  partial palette keeps each captured color on its ANSI index and fills only
  the unanswered slots from the ANSI fallback.
- A canonical `theme` value always wins, even when it is not currently
  registered (a saved `system` before capture, or a removed custom theme), so
  startup never overwrites it. Legacy import only happens when the canonical
  file has no `theme` key, and the legacy read is scoped to the `[ui]` TOML
  table.
- Consolidating the selection-copy registries made the single shared registry
  live for every modal path: environment modal dialog clicks now invoke the
  global copy handler the shell registers (previously devenv's private
  registry was never set, so those clicks were no-ops). This is the
  cross-surface parity the consolidation intends, not a regression.
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
