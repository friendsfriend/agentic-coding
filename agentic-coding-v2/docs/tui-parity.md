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

## Assistant order and markdown block restoration pass

- Render assistant text, thinking, tool calls and images in their recorded
  content-part order. Text no longer jumps ahead of every thinking/tool card or
  joins across intervening parts. Plain-string assistant content remains readable;
  unsupported assistant part types receive a muted, non-interpreting notice.
- Keep unique native call/result pairing and partial-versus-retained fences intact.
  Retained byte changes replace the presentation row. A live generation keeps its
  carrier only under the same native conversation/task/attempt identity; its
  content-part carriers keep thinking folds and markdown resources mounted as
  supplied partial bytes change.
- Port original AssistantMarkdown, markdown block splitting, streaming-tail
  holdback and keyed part slots locally. Code/prose rendering modes and one-row
  inter-block margins follow the original flow. This is a display transformation;
  source messages and retained bytes are not edited or committed by the renderer.
- Restore original 240-document per-view markdown LRU, prune it to observed text
  parts and release it on teardown. That UI cap does not expand the native history
  window or authorize reads. Syntax style ownership remains with the renderer.
- Use the same block composition for standalone retained and volatile text.
  Retained cache keys are scoped to the native standalone UUID and UI row index,
  never a durable task/session alias. The standalone projection supplies no
  generation/attempt ID: volatile text is re-lexed rather than carrying a settled
  parse cache across an inferred attempt.
- Mermaid's custom diagram render node and transcript viewport/window anchoring
  are not restored by these ports. Mermaid remains readable fenced source; no
  render service, provider, shell or runtime authority is introduced.

## Above-prompt slash autocomplete restoration pass

- Port original PromptSuggestions composition locally: accent left rule, mantle
  surface, fourteen-cell command gutter, two-cell row gap, native selection
  colors, eight-row scrolling window and the original remaining-item count.
- Bind the existing native command catalog, not legacy handlers. Command names
  occupy the original gutter; explicit targets/placeholders remain visible in the
  description and are copied into prepared text. No new backend command is added.
- Keep a presentation-only draft mirror synchronized with typing, restores,
  accepted-input recall and guarded clears. Native submission still reads the
  actual editor buffer and retains its origin, ownership and revision checks.
- Preserve history-arrow precedence at logical prompt boundaries; otherwise
  arrows cycle visible slash suggestions. Tab and primary non-drag row activation
  complete only a bare slash prefix. Whitespace-bearing/multiline drafts and the
  literal `//` escape are not replaced by autocomplete.
- Adapt original autocomplete Enter routing to native authority: a differing
  selected suggestion is prepared only. A later explicit Enter on the exact
  edited draft reaches the existing submit path; exact singleton commands dismiss
  the suggestion surface. Preparation never records accepted-input history.
- Recheck actual buffer eligibility and the current catalog before completion.
  Stale completions preserve the unsent draft and consume that completion Enter
  without dispatch. Help, palette, editor, focus and pending-submission guards
  disable suggestion controls; opening help alone preserves its selection.
- Contextual footer labels distinguish Enter preparation from submission and
  expose Tab completion while the list is open. Prompt help documents these
  conditional keys without adding a global command-dispatch layer.

## Recorded timing and prompt usage restoration pass

- Port original Stamp and clock/duration/token/cost formats locally. User prompts
  regain the clock beside their disclosure; thinking headers regain a right-edge
  clock without changing their folds, selection or committed-partial labels.
- Tool headers regain right-edge recorded timing. Native SDK result timestamps
  describe results, not tool starts, so their clocks explicitly say `result`.
  Optional reported result durations use original millisecond/second/minute
  formatting and the original ten-second warning threshold; the duplicate raw
  duration suffix is removed from the status line.
- Accept only finite, nonnegative recorded numeric fields; invalid date ranges,
  missing values and string timestamps remain absent. No timestamp is borrowed
  from another message, commit, task or live slot, and no elapsed-time timer or
  fabricated start time is introduced. The standalone projection supplies no
  message timestamps, so its prompt clocks remain absent.
- Bind the original SessionPrompt right-hand meter to native reported input,
  output and cost totals. The gateway aggregates only returned history: `window`
  and `cached window` labels retain that scope, including stale observations.
  This is not lifetime spend, charged billing, active-context sizing or tokens/s.
- Unknown context-window/percentage and generation timing are not inferred from
  aggregate usage. Cache-token totals remain native source data, not guessed
  current context. Remaining progress/context composition is tracked below.

## Fixed workspace pins and identity navigation restoration pass

- Restore the original fixed pinned section above the scrolling resources in
  both expanded and compact sidebars. OpenCode → Pi → Pi Durable → Orchestrator
  retain their order, two-line expanded/one-line compact PinRow composition and
  the original muted divider with two-cell left inset.
- Scroll only resources beneath the pins; selecting a pin preserves the resource
  viewport. Reveal calculations use the resource offset and actual row height,
  including the compact strip rather than an assumed two-line row.
- Restore wraparound previous/next navigation across the complete visible entry
  space. Empty lists remain inert; movement from an unavailable identity requires
  an explicit key before choosing the first/last visible entry.
- Keep the local cursor by native navigation identity, not a positional index.
  Native updates/reordering preserve that identity; a removed entry does not
  silently become a different Enter target. Pointer activation also rechecks
  that its retained identity still exists before invoking UI navigation.
- No filter, pin preference, workflow phase or status is synthesized from legacy
  observations. Native resource row families, filter composition
  and sidebar preference persistence remain incomplete; this pass restores the
  fixed-pin structure and navigation, not the entire original sidebar.

## Workspace expansion animation restoration pass

- Port the original 150 ms cubic ease-out expansion in sixteen-millisecond
  steps. Resize or mode/focus changes replace the one active interval, with
  untracked width reads so animation frames cannot restart their own tween.
- Preserve the current native responsive allocation (six compact columns, up to
  thirty-four expanded columns). Full row/panel composition appears only when
  expansion is requested and width reaches the original fourteen-column gate;
  narrower allocations retain compact presentation rather than squeeze full rows.
- Collapse immediately to six columns and stop the interval. State gates both
  geometry and content, so delayed/stale expanded width cannot keep the full
  surface visible after a collapse. Teardown cancels animation resources.
- Restore original title-toggle active/hover tones and compact-strip hover fill;
  the glyph reflects permanent versus auto-collapse mode even at narrow widths.
  Background taps focus the sidebar through the original primary/non-drag rule,
  while the nested toggle stops propagation.
- Width changes feed the existing native panel allocation, and row reveal tracks
  the compact/full presentation threshold. This is a UI animation, not execution
  timing; no native mutation, preference persistence or draft replacement occurs.

## Center-column breadcrumbs and agent cursor restoration pass

- Report the agent sidebar's actual allocated width through its local native
  adapter, as the workspace sidebar already does. The breadcrumb's original
  shortening/composition now receives terminal columns minus both sidebars and
  its two padding cells, rather than assuming it owns the full terminal.
- Recalculate that budget during resize, workspace animation and agent sidebar
  mode/focus changes. No fixed guessed agent width, route-schema change or native
  lookup/mutation is introduced. Breadcrumb keyboard focus remains unfinished.
- Preserve the native agent cursor's preferred identity during metadata updates.
  Only explicit route-selection changes synchronize the route preference; polling
  no longer resets an in-progress arrow selection to the displayed conversation.
- Establish a first visible cursor only when no preference exists. A missing
  preferred key remains unselected, rather than becoming row zero; explicit
  movement selects a visible boundary entry. Keep the existing clamped agent-row
  movement (workspace navigation retains its separate wraparound behavior).
- Enter and pointer opening recheck the selected native child identity against
  current sessions before UI navigation. No missing row is adopted as another
  session and no navigation action is treated as work admission.

## Native command palette list restoration pass

- Reuse the original local PromptSuggestions body rather than a separate
  five-row approximation: eight-row centered window, fourteen-cell name gutter,
  two-cell gap, selection tones, accent rule and remaining-item indicator.
  Keep the existing native safety header/filter/footer; this is not a claim that
  the original location or model-picker modal has been restored.
- Keep native explicit targets/placeholders visible in row descriptions, while
  full command text remains the preparation payload. Retain the existing
  sixty-four-match bound and deduplicate exact matching command text.
- Preserve selection by full command identity during catalog changes, not a
  position that could silently acquire another target. Explicit query edits
  reset the cursor to the first eligible match; disappearing selections remain
  unavailable until another selection is made. Existing clamped movement stays.
- Gate the palette key layer, input changes, pointer selection/activation,
  preparation and dismissal on its actual active state. Help can suppress the
  mounted palette without letting its controls alter the preserved search.
- Recheck current filtered eligibility before preparing retained command text.
  Completion still goes through the existing unsent-draft refusal, and never
  submits, approves, reconnects, records accepted history or invokes a gateway
  mutation. No renderer/helper tests or visual acceptance are introduced.

## Still required before claiming parity

- Original workspace filter/pin ordering, side/mode persistence and complete
  navigation/focus key catalogs, including keyboard breadcrumb focus.
- Remaining original modal components, selection/clipboard interactions and
  notification placement; the restored read-only help frame is not general
  modal parity.
- Remaining orchestrator/durable transcript composition: original viewport/window
  anchoring, Mermaid diagram rendering, remaining specialized tool families and
  file/shell header/section composition, remaining timing coverage and
  progress/context arrangement,
  remaining prompt history details and model/thinking/argument picker behavior.
- Remaining standalone detail/header, profile-picker and focus composition;
  its independent native identities must never alias durable conversations.
- Original settings/provider/wiki/schedules/environment list/detail composition;
  adapt only content and controls incompatible with native authority.
- Interaction/lifecycle audit and terminal visual verification. Compilation,
  functional boundary tests and a successful build do not establish visual parity.

No renderer, snapshot, helper or navigation-matrix tests are introduced. No
credentials, real provider calls, application restarts or deployments are part
of this restoration pass.
