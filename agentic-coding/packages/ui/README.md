# `@agentic-coding/ui` — the shared UI framework

One component set for every surface: the shell (Home/destinations, dashboard,
observability, wiki), the environment feature, and the standalone dashboards.

```
packages/ui/src/
  index.ts        # the barrel; every consumer imports "@agentic-coding/ui"
  components/     # primitives and composites (Card, Selectable, StatusBar, Text, …)
  components/utils/
  theme/          # semantic colours, the theme registry, scrollbar tokens
  views/          # multi-part views: the review renderers (diff, markdown) and
                  # their annotation renderer
```

## Rules

- **Import from `@agentic-coding/ui`.** The barrel is the only entry point; `bun` and `tsc`
  both resolve it, and subpath imports (`@agentic-coding/ui/components/...`) do not resolve at
  runtime. Inside the package, modules import each other relatively so the
  barrel never has to import itself.
- **A component has exactly one implementation.** A surface that needs a
  different *behaviour* passes a prop; it does not fork the component.
- **No domain or service inside `components/`.** Views may take domain-shaped
  props (they are views), but primitives stay data-free.
- **Semantic colours only** — `uiColors`/`theme` tokens, never a raw palette.

## Live list identity

`ScrollableList` and `SelectableList` accept `itemKey` for durable row identity
across refreshed object snapshots and reordering. Include the owning scope in
the key when IDs are not globally unique. Without `itemKey`, the list preserves
item-reference identity; duplicate occurrences get separate mounted rows.

The interaction/hover surface remains mounted while its identity is visible.
Rows leaving the virtual window are disposed. The legacy `renderItem` still
refreshes its content when data/index/selection changes; use `renderReactiveItem`
for stateful content that must also stay mounted:

```tsx
<ScrollableList
  items={items()}
  itemKey={(item) => item.id}
  selectedIndex={selected()}
  renderItem={(item) => <text>{item.label}</text>}
  renderReactiveItem={(item, selected, index) => (
    <Row item={item()} selected={selected()} index={index()} />
  )}
/>
```

Reactive renderers receive accessors. Read them inside JSX or reactive
computations, not into setup-time constants. Ordinary refreshes must not key an
entire component on a changing payload object.

Custom list layouts can use `createKeyedItems` from the same package: it returns
stable slots with reactive `value()` accessors, keyed by an explicit identity
function. Duplicate identities retain separate occurrence slots. Slots removed
from the current list are released; genuine structural changes should be part
of the identity when they require a different native renderer.

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

Review surfaces render thread collections through `DiscussionList`, keyed by
discussion ID. `DiscussionThread` retains notes by thread/note ID and reads the
first note and count reactively, so refreshed payloads update existing message
renderers and notes arriving after an initially empty thread can appear.

Review viewers separate source/comment metadata refresh from selection-driven
scrolling. A comment update or fresh file wrapper with unchanged source must
not reveal the selected row again while the reader is elsewhere. File,
selection and presentation-mode changes may reveal it; split Markdown targets
are resolved inside the side columns after layout.

Raw diff projections also reuse fully unchanged unified/split records within
the same file. All content, type and source coordinates must match; changed
records and different files start fresh. Retained rows resolve their selectable
index reactively instead of keeping a setup-time index.

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
