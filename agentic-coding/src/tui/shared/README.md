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