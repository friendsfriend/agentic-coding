# `@ui` — the shared UI framework

One component set for every surface: the shell (Home/destinations, dashboard,
observability, wiki), the environment feature, and the standalone dashboards.

```
packages/ui/src/
  index.ts        # the barrel; every consumer imports "@ui"
  components/     # primitives and composites (Card, Selectable, StatusBar, Text, …)
  components/utils/
  theme/          # semantic colours, the theme registry, scrollbar tokens
  views/          # multi-part views: the review renderers (diff, markdown) and
                  # their annotation renderer
```

## Rules

- **Import from `@ui`.** The barrel is the only entry point; `bun` and `tsc`
  both resolve it, and subpath imports (`@ui/components/...`) do not resolve at
  runtime. Inside the package, modules import each other relatively so the
  barrel never has to import itself.
- **A component has exactly one implementation.** A surface that needs a
  different *behaviour* passes a prop; it does not fork the component.
- **No domain or service inside `components/`.** Views may take domain-shaped
  props (they are views), but primitives stay data-free.
- **Semantic colours only** — `uiColors`/`theme` tokens, never a raw palette.

## The review views (`views/`)

`DiffReviewView` and `MarkdownReviewView` render a review surface: selectable
rows, visual range selection, inline annotations, a comment composer, and (for
the diff) split/unified layout and whole-file add/delete handling.

Annotations are **one mechanism**: comments and review findings are both
`Discussion` records from `views/types.ts` and both render through
`DiscussionThread` from `views/annotations.tsx`. A finding is a discussion that
carries `findingId`/`findingSeverity`; that is the only visual difference (the
FIX marker and severity colour). `ReplyAffordance` is the one reply
prompt/composer, shown when the caller supplies `onReplyToDiscussion`.

Surface differences are flags, never forks:

| flag | surface that uses it |
|---|---|
| `page` | the shell's wiki note page (fills the host body, no dialog chrome) |
| `renderMarkdown` | OpenSpec artifacts rendered as block-level markdown |
| `currentSideOnly` | wiki reviews: comments only on the current side |
| `onReplyToDiscussion` | the environment's change-request viewer (threaded replies) |
| `onSelectedFindingIdsChange`, `onSelectedSourceRangeChange`, `onDiscussionLineIndicesChange` | the dashboard review |

## Deliberate surface presets (not duplicates)

These files are small on purpose and are documented as presets:

| file | why it exists |
|---|---|
| `devenv/ui/components/GenericModal` | pins the env dialog alpha and click policy |
| `dash/devenv-ui/components/GenericModal` | the shell's modal framing defaults |
| `otel/components/GenericModal` | the shell's own portaled modal (keybind handoff) |
| `devenv/ui/components/ErrorDialog` | env-specific error dialog layout |
| `dash/ui/Header` | the dashboard's branded header for standalone `--home` mode |
| `dash/ui/Notification`, `otel/components/Notification` | bind the surface's notification store to the shared overlay |
| `devenv/ui/components/MarkdownModal` | display-only markdown viewer (no annotations), used by the env |

Anything else with the same name as a framework component is a bug: it should
be a prop instead.
