# Design

## Context

See proposal.md — Why. Current state that shapes the approach:

- `src/tui/dash/panels/EvidencePanel.tsx` renders one fixed-height row of the
  detail grid (`evidencePanelLines`, 1–8 lines), listing
  `evidenceRows()` — every manifest entry, newest first, grouped by debug
  request — with a right-hand preview column that mounts `<image>` only when
  `inlineImagePreview(renderer.capabilities)` says the renderer will draw it.
- `src/tui/dash/evidence-panel.ts` is the panel's pure view model (rows, row
  labels, the previewed entry, metadata lines). `src/tui/dash/evidence-open.ts`
  composes the stored file's path through the evidence store's own
  `workflowEvidenceFilePath` and hands it to `side-app.ts`.
- `src/tui/dash/App.tsx` owns the evidence manifest read, the selected entry's
  preview read, the kitty signal, and the dashboard's keymap layers. The
  agent-session page is the existing precedent for a *page* of the dashboard
  body: a state signal plus a keymap field (`agent.view`), the grid rendered
  with `visible={false}` so scroll positions survive, and a keymap layer that
  requires the field.
- Evidence entries live under `<data root>/evidence/<workflowId>/[req-…/]<ulid>.<ext>`
  with one atomic `manifest.json`; `server/evidence/store.ts` owns kinds,
  content checks and caps, and `contracts/environment.ts` owns the entry and
  attach schemas. The dashboard reads an entry's bytes by id through
  `gateway.evidenceFile`, so anything the subview must render has to be an
  entry.
- The wiki's citations are inline `[^source-id]` markers in a markdown body
  (`workflow/wiki.ts` `citationReport`), rendered by the same block renderer the
  wiki page uses (`parseMarkdownBlocks` + `MarkdownBlockView`, see
  `MarkdownReviewView`). There is no second markdown renderer to reuse instead.

## Goals / Non-Goals

**Goals:**

- One bounded summary row in place of the listing; the subview carries the
  reading surface.
- A report attachment that is additive to the store contract and needs no
  manifest version bump, no new evidence kind, and no new read route.
- The subview reuses the existing rows, labels, path composition, opener and
  kitty probe; the only new rendering is the report pane.

**Non-Goals:**

- Generating a report. The dashboard neither writes evidence nor invents a
  report from the manifest.
- Making citations clickable/focusable, or jumping from a citation to its
  sidebar row.
- Changing the evidence store's path rule, caps, kinds, lifecycle or deletion.
- A second markdown renderer, a new citation syntax, or a new image protocol
  probe.

## Decisions

### The report is an ordinary entry carrying an optional `report` flag

`evidenceEntrySchema` and `evidenceAttachRequestSchema` gain
`report: Schema.optional(Schema.Boolean)`; `attachEvidence` copies the flag onto
the recorded entry exactly like `pinned`. `evidence_attach` gains a `report`
parameter whose description says it marks the run's markdown report.

Rules:

- A flagged attach MUST be kind `other` with a `md`/`markdown` extension and
  text content (no NUL, decodable UTF-8). `other` is the only kind that accepts
  an arbitrary extension today, and the text check reuses the rule the
  `log`/`script` kinds already apply, so no new content machinery is needed.
- The report is *the newest entry whose `report` is true*; the reader needs no
  mutation, so a revised report is a second flagged entry and the older one
  stays an ordinary listed entry. No uniqueness enforcement in the store.
- The flag is additive and readers already tolerate unknown fields
  (`requireEntry` casts; Effect `Schema.Struct` ignores excess properties), so
  `EVIDENCE_MANIFEST_VERSION` stays 1 and a manifest without the flag reads
  exactly as before.

Alternatives rejected:

- **A new `report` evidence kind**: touches the kind union, `KIND_RULES`, the
  attach tool schema, the dashboard's summary kinds and every place that maps a
  kind to a glyph, for one boolean of information — and the goal fixes the
  summary's kind list at the six existing kinds.
- **A manifest-level `report` object**: the file would not be an entry, so
  `GET /api/v1/evidence/{workflowId}/{id}` and `evidenceEntry(id)` (which look
  an entry up by id) could not serve it; the dashboard would need a second read
  path and the store a second writer.
- **A designated markdown file found by extension**: no schema change, but an
  agent's `.md` log would silently become the run's report, and "which of two
  markdown files is the report" would be a guess.

### Reconciled with `add-stage-flow-evidence` (merged before this change)

`add-stage-flow-evidence` landed an Evidence *listing* with a flow grouping and
an open-flow-page action on the panel. This change moves the listing into the
subview, so that behavior moves with it rather than being dropped:

- **The summary row keeps the journal's meaning.** The panel's kind counts are
  the manifest's counts, and the row carries a `flow` accessory whenever the
  workflow recorded a stage flow — the marker that says the subview's sidebar is
  grouped by segment. A `report` accessory marks a flagged report entry. Neither
  marker is a listing: the row still holds one line whatever the manifest holds.
- **The requirement moves with it.** The merged `Flow grouping in the evidence panel`
  requirement is RENAMED to `Flow grouping in the evidence subview sidebar` and
  MODIFIED there, so the base spec states what the code does instead of keeping
  the panel-level requirement the summary row replaced.
- **The grouping itself moves unchanged.** `evidenceRows(entries, journal)` keeps
  both groupings — segment groups in journal order with the journal step rows in
  them, then a trailing group, or debug-request groups newest-first without a
  journal — and the subview's sidebar is its only renderer. The panel no longer
  renders rows at all, so the previous panel-level `j/k` selection is gone.
- **Step rows keep their behavior.** A journal step row names no file: `Enter`
  on it opens the workflow's `stage-flow.html`, and `y` says why there is nothing
  to copy instead of silently doing nothing. The subview's key handler owns both
  branches, so the coverage those tests had is kept, not dropped.
- **The open-flow action moves into the subview.**
  `evidenceSubviewKeybindCatalog({ flow })` advertises `f` only when the workflow
  has a flow page, and `dashboardDetailKeybindCatalog` loses its `evidenceFlow`
  option and the `f`/`y` entries — the grid advertises exactly one Evidence
  action (`Enter`). The action stays unavailable (reported, not stale-opened)
  without a flow page.

### The subview is a dashboard body page, not a dialog or a shell route

Follow the agent-session precedent: `evidenceSubviewOpen` state in `App.tsx`,
the panel grid rendered with `visible={false}` while it is open (so panel scroll
positions survive the round trip), the page rendered in the same body slot, and
a keymap field of its own.

- `keymap-setup.ts` registers an `evidenceView` field over a new
  `evidence.view` data key ("none" | "open"). The keymap's `detail` grid layer
  gains `evidenceView: "none"`, and the subview registers its own layer at
  priority 1000 requiring `evidenceView: "open"`.
- The same two safety nets the agent session page has are repeated: a
  `createEffect` repair and a `keymap.intercept("key", …)` repair that resets
  `evidence.view` to "none" whenever the page is closed, so the grid can never
  be left without keys.
- `keybindCatalog` chooses a new `evidenceSubviewKeybindCatalog()` while the
  page is open (like `agentSessionKeybindCatalog()`), so both the footer and the
  `?` help modal list the page's keys and the grid's evidence entries stop
  advertising themselves.
- Panel keys: `Enter` opens the page. The panel's `y` (copy) and per-row
  `Enter` move to the subview, so the panel section in
  `dashboardDetailKeybindCatalog` becomes one entry.
- Subview keys: `j/k` and `↑/↓` move the sidebar selection, `Enter` opens the
  focused entry (or the flow page on a journal step row), `y` copies its path,
  `f` opens `stage-flow.html` when the workflow has one, `PgUp/PgDn` and
  `Ctrl+U/Ctrl+D` scroll the report, `Esc` returns. There is deliberately no
  report/sidebar focus toggle: the sidebar owns the selection keys and the
  report has its own scroll keys, which keeps one focus ring and keeps selection
  free of I/O (the property the panel's `wheelMovesCursor={false}` protects
today).

### View model split

- `src/tui/dash/evidence-panel.ts` keeps the manifest-to-display purity and
  gains `evidenceKindCounts(entries)`, `evidenceKindSummary(entries)` (fixed
  kind order, singular/plural, zero-count kinds omitted) and
  `evidenceReportEntry(entries)` (newest flagged entry). `evidencePanelLines`
  drops its terminal-share cap and answers 2 lines for "has entries" and for
  the loading/error message, 1 for the empty state.
- A new `src/tui/dash/evidence-report.ts` owns the report's pure view model:
  - `evidenceCitations(report, entries)` → the cited ids in first-citation
    order, each with its resolved entry or `undefined`;
  - `renderEvidenceReport(report, entries)` → the report text with every
    `[^id]` marker rewritten: a resolved id keeps the wiki's marker form, an
    unresolved id becomes a bold `[^id ⚠ unknown evidence]` (bold because the
    markdown renderable cannot colour one token, so weight is what stays visible
    in a monochrome terminal);
  - `evidenceReportSections(report, entries)` → ordered sections for the left
    pane: one `markdown` section per top-level block from `parseMarkdownBlocks`,
    an `image` section for each cited screenshot right after the block that
    first cites it (capped, in citation order), and a trailing `sources` section
    built from `evidenceRowLabel`/kind glyph plus a "not in this manifest" row
    per unknown id.
- `EvidencePreviewEntry` (video-poster preview) is removed: only screenshots are
  cited, and the panel no longer previews a selection.
  `evidenceDetailLines` stays and is rendered under the sidebar list as the
  focused entry's metadata (path, size, producer, caption) — that is the
  non-kitty text fallback the panel used to provide.

### Report and image reads

- `src/tui/data/evidence.ts` gains `loadEvidenceText(repo, workflowId, id)`: the
  existing immutable per-entry byte read (`evidenceFileKey`) decoded as UTF-8 and
  bounded to 200 000 characters, so a huge `.md` cannot become a huge render.
- `App.tsx` reads the report only while the subview is open and a report entry
  exists, with the same generation/abort pattern the manifest and preview reads
  use, and exposes `loading`/`ready`/`absent`/`error`/`none`.
- Cited screenshot bytes are read only while the subview is open *and* the kitty
  probe says the renderer will draw them, at most four images
  (`MAX_REPORT_IMAGES`), in citation order. Each id is an immutable cache key, so
  a re-open does not re-read.

### Rendering the report pane

Left pane: a column inside a scroll box (`onScrollBoxReady` published to
`App.tsx` so `PgUp/PgDn` can scroll it), one `MarkdownBlockView` per markdown
section — the wiki's own renderer and syntax style — an `<image source={bytes}
fit="fit">` for an image section (mounted only when kitty and the bytes are
loaded; otherwise the entry's metadata line), and the sources rows in the
muted/secondary colours the wiki's frontmatter/source rows use. The report text
is rendered from our rewritten markers, never by relying on the markdown
engine's footnote handling.

Right pane: the existing `SelectableList` over `evidenceRows()` — which is the
flow grouping when the workflow has a stage journal and the debug-request
grouping otherwise — with the panel's row labels and group headers, the focused
row's `evidenceDetailLines` (or `evidenceStepDetailLines` for a journal step)
under it, and the same tap-to-select / tap-to-activate wiring the panel had.

The panel body is the summary line only: `evidenceKindSummary(entries)`, with
the existing accessory carrying the read state (empty/loading/error) and the
`report`/`flow` markers when a report entry or a stage flow exists.

## Risks / Trade-offs

- **The report counts as an `other` entry in the summary** → accepted: the
  summary is a faithful count of the manifest, and the sidebar's row label marks
  the flagged entry as the report so it is not mistaken for browsing material.
- **A monochrome unknown-citation marker** → bold plus the words "unknown
  evidence" keeps it visible under any theme; the sources section repeats it as
  its own row.
- **`<markdown>` per block is heavier than one document render** → the report is
  one-to-few blocks with no streaming, and the wiki page already renders this
  way, so the cost is the existing accepted cost.
- **Reading image bytes on open** → capped at four screenshots, kitty-gated, and
  keyed by immutable id; a missing file degrades to the metadata line.
- **A page that forgets to reset its keymap field** would leave the grid without
  keys → the effect plus `keymap.intercept` repair mirror the agent-session
  page, and the page test asserts `Esc` restores the grid's keys.
- **Older builds reading a flagged manifest** → the extra field is ignored; the
  manifest version stays 1 because the change is additive.

## Migration Plan

No migration. Existing manifests, entries and paths are untouched; the flag only
appears on entries attached with it. Rollback is removing the UI page: the flag
stays readable as an unknown field and the store's behavior for unflagged
attaches is unchanged.

## Open Questions

None blocking. Two questions a human may want to steer, both with a working
default taken above: whether the report entry should be excluded from the
summary's kind counts (default: included), and whether a report should be
replaceable in place (default: newest flagged entry wins, older ones stay listed).
