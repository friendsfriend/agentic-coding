# Restore the original TUI, not a redesign

Baseline: `agentic-coding/src/tui/otel/app/App.tsx` and the original
`agentic-coding/packages/ui/src/components`. Native architecture changes affect
content and bindings, not permission to replace the original presentation.

## First restoration pass

- Restore original compact `AGENTIC CODING` shell header and original Badge.
- Port original StatusBar/HelpText and key-chip dispatch. Native key catalogs
  remain the source; F1 is the current native help binding. Restore clipping,
  right-pinned help and one-row default footer, not wrapped plain text.
- Port original BreadcrumbRow and its bounded layout over native structural
  locations. Restore the blank row and horizontal content spacing.
- Port original semantic colors, Badge/Text/Highlight, Panel, selectable row,
  shared terminal geometry and pointer gesture/hover behavior locally. The only
  palette-source adaptation is the native theme resolver. No legacy runtime,
  settings, engine or transport imports.
- Restore workspace pin row heights, marker, glyphs, clipping and tones, and
  34-column expanded / 6-column compact sidebar geometry. Navigation adapts to
  native entries; this is not yet the entire original WorkspaceSidebar.
- Port the original AgentSidebar presentation, scroll window and geometry,
  binding it to native child conversations and recorded task observations.
  Unknown status remains unknown; writability is not proof of running work.
- Move memory/native viewpoints into workspace entries. Restoring them remains
  UI-only and retains the existing native identity/ownership checks.
- Replace boxed environment/schedule resource rows with the original selectable
  row chrome. Retain explicit read/preparation and revision fences.

## Conversation restoration pass

- Extract the original prompt's left-ruled raised surface, top pulse line,
  input padding and role/model/thinking metadata row. Restore a one-to-eight-row
  editor instead of the fixed five-row top-bordered input. Retain native draft,
  command routing, focus exclusions and admission checks.
- Port the original monotonic blinking, final-frame prompt cursor with its
  grapheme-preserving paint and renderer/timer cleanup.
- Port original UserPrompt paragraph spacing, five-line preview, disclosure and
  hover surface. Folding uses the existing UI-only expansion memory; message
  text is plain text, not markdown interpreted from a user prompt.
- Restore assistant three-cell inset/unboxed markdown and thinking's unboxed
  muted italic detail, warning-toned fold and recorded-partial spinner.
- Port original shared MarkdownViewer and syntax palette. The native renderer
  owns cached syntax styles; individual transcript cleanup must not destroy a
  style shared with another mounted surface. v2 still uses its single local
  Catppuccin palette, not legacy theme/settings authority.
- Restore heavy tool-call rules, paragraph padding, hover surface, original icon
  gutters and primary-colored labels. Animate only an observed running native
  slot, never a model's partial tool intent. Keep explicit unknown/ambiguous,
  retained-result and waiting-on-owned-work wording.
- Use original primary-button tap/drag classification for transcript header and
  section folding. Output selection/dragging does not collapse a tool card.

## Prompt history and standalone conversation pass

- Restore plain Up/Down history browsing only at the editor's first/last logical
  line, and only for empty or unchanged recalled input. Newly typed/edited drafts
  remain untouched. Explicit Alt-arrow recall keeps its separate native bounded
  history contract and original-draft restoration; no confirmations or mutation
  commands enter history.
- Restore `?` help on an empty prompt; typed question marks stay literal otherwise.
  Document these conditional input keys without adding global arrow bindings.
- Bind standalone list rows to their independent native UUIDs, using original
  Selectable chrome instead of enclosing each conversation in a full rectangle.
- Reuse original UserPrompt/MarkdownViewer message surfaces in standalone views.
  Unchanged retained messages survive observation polls, preserving local folds;
  changed bytes/indexes replace rows, and the cache is pruned to the observed
  window. Volatile partial output follows retained messages and remains explicitly
  labeled as non-completion evidence.
- Restore the original autocomplete's left-ruled raised surface, fourteen-cell
  command column, selected colors and first-select/then-activate mouse gestures
  for the explicit native command palette. Filtering/preparation remains native:
  choosing never submits or overwrites an existing unsent draft. Selection is
  clamped when the observed command catalog shrinks.

## Read-only help overlay restoration pass

- Extract original HelpModal/GenericModal read-only framing locally: centered
  portal, 72% terminal width / 78% height, 35%-alpha black backdrop, borderless
  mantle surface, original two-cell horizontal / one-cell vertical padding,
  SearchHeader title row, section/key colors and fourteen-cell key gutter.
- Restore original wrapped HelpText footer/chip dispatch and primary-button,
  non-drag backdrop dismissal. This frame is help-only, not a general draft,
  secret, confirmation or running-operation dialog.
- Bind native help scrolling to j/k, arrows, Page Up/Down and Home/End; Escape,
  F1 and ? dismiss only this layer. Other input keys are consumed rather than
  reaching underlying route, preparation or submission controls. Layer teardown
  is deferred until the current native keymap dispatch completes.
- Keep the underlying page mounted; opening help no longer replaces the page
  body and destroys local folds. Prompt, palette and resource editors lose input
  focus while help is open, without clearing their drafts or parent edit mode.
- Use native command/key catalogs as content. Window long native descriptions
  by their wrapped visual rows so scrolling can reach all continuation lines;
  terminal resize updates the content budget and clamps the help offset.

## File/diff and shell tool body restoration pass

- Restore original TranscriptFile code composition: muted line-number gutter,
  three-cell minimum width, one-cell separator, requested starting offset,
  primary-colored word-wrapped code and original grammar aliases. Supplied
  retained/requested text is not rewritten into a guessed live file snapshot.
- Restore original native diff composition: line numbers, semantic red/green
  backgrounds and signs, unified view through 120 content columns and split view
  above that width. The tool card supplies the original hover context; lifting
  the surface preserves the diff's red/green tint.
- Keep non-unified/multi-file diff bytes readable as text rather than letting
  OpenTUI's first-file-only diff renderer hide other retained files. No patch is
  synthesized, no applied result is inferred, and there are no file/apply actions.
- Port original TranscriptShellOutput compact tail, command-aware row budget,
  muted/error tones, character wrapping and size tracking. Observed retained or
  bounded slot output can appear while the card is folded; generated partial
  tool intent alone cannot create a shell execution preview.
- Preserve native argument/output/detail fold keys. Expanding the output shows
  all supplied text without the preview's display cut, and removes the redundant
  second shell-result body. Bounded slot output and native dropped-byte/line
  counters remain explicitly labeled, not represented as a terminal result.
- Syntax style lifetime remains renderer-owned. Legacy ToolView/viewport imports
  are not used; viewport caching and the complete ordered block flow remain work
  below, rather than being claimed restored by these body ports.

## Still required before claiming parity

- Original workspace filter/pin ordering, side/mode persistence and complete
  navigation/focus key catalogs, including keyboard breadcrumb focus.
- Remaining original modal components, selection/clipboard interactions and
  notification placement; the restored read-only help frame is not general
  modal parity.
- Remaining orchestrator/durable transcript composition: original ordered
  markdown block/cache/viewport flow, remaining specialized tool families and
  file/shell header/section composition, timestamps, usage/progress arrangement,
  prompt history/autocomplete and picker behavior.
- Remaining standalone detail/header, profile-picker and focus composition;
  its independent native identities must never alias durable conversations.
- Original settings/provider/wiki/schedules/environment list/detail composition;
  adapt only content and controls incompatible with native authority.
- Interaction/lifecycle audit and terminal visual verification. Compilation,
  functional boundary tests and a successful build do not establish visual parity.

No renderer, snapshot, helper or navigation-matrix tests are introduced. No
credentials, real provider calls, application restarts or deployments are part
of this restoration pass.
