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
  lookup/mutation is introduced. Keyboard focus is covered in the subsequent
  restoration pass below.
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

## Breadcrumb keyboard focus restoration pass

- Restore the original two-region breadcrumb/content Tab and Shift+Tab cycle on
  providers, profiles, skills, observability and settings pages. Embedded chats,
  task/review, wiki, schedule and environment bodies retain their own Tab keys;
  active bare-slash completion also keeps precedence over page focus cycling.
- Explicit pointer breadcrumb focus can be left with Tab or Escape even on an
  embedded page. Current-location taps/Enter no longer add duplicate history
  entries. Restore the original bold/accent breadcrumb cursor, resting at the
  current location until moved.
- Restore h/k/Left/Up and l/j/Right/Down clamped ancestor movement and Enter
  navigation over the structural chain, with native route-identity selection.
  Missing identities have no Enter target; movement explicitly selects another
  visible ancestor. Pointer and keyboard navigation recheck the current chain.
- Breadcrumb focus disables the underlying prompt, history recall, autocomplete,
  page controls, transcript controls and workbench/diagnostics focus. Help,
  palette, busy and editor states suppress breadcrumb interaction. Starting a
  native editor exits breadcrumb focus without modifying its existing draft.
- Keep focus transient and local: no View/viewpoint protocol additions, inferred
  execution identities, command dispatch, approval or history admission. Back,
  forward and explicit route changes reset this local cursor while preserving
  existing draft/scroll restoration. Enter cannot submit the underlying prompt.
- Add accurate page-focus/breadcrumb help catalogs and contextual footer keys.
  Existing shell shortcuts are retained. No navigation-matrix/presenter tests or
  visual acceptance claims accompany this pass.

## Native agent Active/All and size-key restoration pass

- Restore the original focused-agent F Active/All toggle, initially Active, and
  E expanding/permanent size toggle. The existing original sidebar composition,
  row geometry, pointer size control and clamped navigation remain unchanged.
  The agent help catalog/footer now advertises filter and size keys.
- Project pending only from reported idle/queued work and working only from
  reported running activity. Unfamiliar activity values, missing task metadata,
  child observations without a catalog task and writability never imply an
  active run.
  Awaiting-review observations stay blocked rather than running.
- Active contains pending/working rows only; All exposes blocked, terminal and
  unknown observations. Disconnected nonterminal observations become unknown,
  not current running/queued claims; retained reported terminal outcomes remain
  displayable. This filter is local UI state, not a fresh native inspection.
- Preserve preferred identity across filters without selecting a fallback row.
  Hidden/missing preferences have no Enter target; explicit movement can choose
  another visible entry, and switching back restores a still-present preference.
  Pointer and Enter opening require current visible membership as well as the
  current native child identity. No hidden selection bypasses Active.
- Distinguish unfocused from covered interaction: normal pointer taps still focus
  the sidebar, but help/palette suppress pointer focus, selection, opening and
  size changes, as well as keyboard filter/size controls.
- No native activity/authority API, provider call, workflow projection, saved-view
  schema, persistence or draft changes. Workspace filter families/persistence and
  full picker composition remain unfinished; no visual acceptance is claimed.

## Workspace size-key and retained-row restoration pass

- Restore the original focused-workspace E expanding/permanent size key through
  the same local mode setter used by the pointer toggle. Keep the existing
  150 ms expansion, immediate collapse, responsive width, fixed four leading
  pins, divider, scroll reveal and wrapped identity navigation.
- Key both fixed and scrolling row families by native entry value, not each
  freshly projected object. A live value-to-entry/index map updates labels,
  descriptions and position without remounting unchanged PinRow interaction
  state during metadata refreshes. Removed identities are evicted; this does
  not promise retention across compact/expanded branch changes.
- Recheck current identity membership before retained pointer activation can
  focus the sidebar, select a cursor or navigate. Missing entries do not mutate
  those UI states and never inherit another row's positional target.
- Separate unfocused from covered interaction. Normal background/row/toggle
  taps can focus the workspace; help and the palette suppress pointer focus,
  activation, mode changes and keyboard commands without changing stored mode.
- Restore the original visible Enter/open footer hint for both workspace and
  agent sidebars, alongside their size key. No native execution/delete/session
  management command is added, and no backend method is invoked by E.
- Workspace filter families still need a native-appropriate resource projection;
  legacy workflow statuses are not fabricated for mode pins, page links or
  UI-only viewpoints. Preferences/persistence remain unfinished. No presenter,
  renderer, navigation-matrix tests or visual acceptance claims are added.

## Tool-call header label/hint restoration pass

- Port the original pure ToolCallHeader composition locally: two-cell action
  gutter (three for the browser family glyph), error/muted icon tones, full
  word-wrapping call label, flexible muted hint limited to forty-five percent,
  and the existing recorded result stamp. No legacy block/store import.
- Native file paths and bash/shell commands now occupy the main label instead
  of a generic tool-name prefix consuming the call's space. Keep the exact
  native tool name visible as the secondary hint; calls without a meaningful
  supplied summary still use their own native name as the main label.
- Bind the spinner only to a supplied running native slot with no retained
  result and no generated partial call. Existing explicit status caveats remain
  below the header, including waiting-on-owned-work/review and unlinked results.
  Only paired result errors set error tone; no inferred start, timer or finish.
- Use the shared tap-vs-drag contract and stop propagation for header-line folds,
  so the containing header does not toggle a second time. Existing argument,
  output/detail folds, anchors, output bodies and pairing fences remain intact.
- Result clocks stay explicitly labelled result and use only validated recorded
  fields. Browser action families, specialized argument/section layouts and
  viewport anchoring remain unfinished. No presenter/rendering tests or visual
  acceptance claims are introduced.

## Browser action and requested-source presentation pass

- Restore the original browser-family action glyph for the known navigation,
  input, wait and observation tools. Keep the three-cell browser gutter and
  native tool-name hint; the wrapping main label now carries the action and
  first supplied ref/selector/URL/text/key, falling back to existing argument
  summary data. No current browser snapshot, URL discovery or action is invoked.
- Restore original script, telemetry, evidence and database glyphs for the
  corresponding explicit native names. Unknown names retain the generic glyph
  and native-name fallback instead of being guessed into an action family.
- Add an independently folded requested-source section for supplied
  browser_run_script/browser_eval JavaScript and db_query SQL, using the shared
  syntax style and original code-content primitive. This reads only string
  arguments; it never evaluates JavaScript or submits a query.
- Distinguish retained intent, generated partial source and unlinked current-round
  source in the fold label and caveat. Neither source bytes nor a syntax-colored
  preview establishes execution/completion. Keep the complete argument JSON,
  retained output/detail folds, diagnostic display and native pairing/status
  bindings; no protocol, provider, approval or environment behavior changes.
- Browser observation/evidence body composition, other specialized sections,
  Mermaid rendering and viewport anchoring remain unfinished. No rendering or
  presenter tests are added and visual parity remains unverified.

## Post-layout selected-row reveal pass

- Share one reveal path between content action scopes and transcript selection,
  instead of duplicating immediate scroll calculations across the shell.
- Coalesce selection into a single pending renderable and request a presentation
  frame. Apply reveal after layout/wrapping using screen-space row and viewport
  coordinates, rather than pre-layout/local coordinates. Already-visible rows
  do not move; rows above/below the viewport use the existing edge placement.
- Drop destroyed/hidden targets and discard pending reveal on navigation restore,
  component cleanup, or while help/palette is open. This is transient UI state,
  not a persisted row identity or native task/session authority.
- Keep saved numeric-scroll restoration, draft protection, ownership, ingress,
  provider behavior and native transcript identities unchanged. Persistent
  reading-place anchors, asynchronous history placement, timeline jumps and
  bottom-following/window stability remain unfinished.
- No renderer, mounting, snapshot, presenter or navigation-matrix tests are
  added. Static checks and public-boundary fixtures do not verify visual parity.

## Retained browser observation sections

- Restore separate Observation and Matches folds for explicit browser navigation,
  input, wait and observation names when their paired retained JSON object carries
  those fields. String observations remain plain terminal text; structured values
  use the existing bounded data presentation. Arrays/scalars at the result root
  and unknown tools retain the generic output path.
- Keep complete structured output, original output bytes, arguments, images,
  diagnostics and details available. Empty arrays/strings are not invented into
  missing observations; null/missing fields add no section.
- Returned refs and snapshot text are inert recorded data, not current browser
  targets or UI permissions. No action, URL discovery or browser session is
  created. Evidence/body families, reading anchors and visual parity remain
  unfinished/unverified; no renderer or presenter tests are added.

## Current-window reading-place and bottom-follow pass

- Register the mounted transcript's existing identity-keyed header anchors with
  the shell. Registration/cleanup is instance-fenced and creates no native
  session/task binding, persisted authority or new view fields.
- Remember a header identity and its screen-space offset while away from the
  bottom. After layout, correct growth/reflow above that header without changing
  transcript selection. Missing/destroyed anchors retain the numeric position
  before sampling the current visible window; no history is fetched or fabricated.
- Once the observed viewport reaches the bottom, follow subsequent height growth.
  Stable-geometry scroll movement and explicit row reveal stop following and
  resample the reading place. Navigation/registration resets the transient state;
  help/palette suspend corrections. Avoid redundant bottom scroll writes.
- This is header-offset anchoring inside the supplied bounded native window,
  not text-line anchoring or original frozen-window/load-older parity. Initial
  asynchronous saved-position placement, simultaneous reader movement/layout
  changes, timeline/latest controls and persistent follow-mode restoration still
  need work and interaction verification. No visual acceptance or renderer tests
  are claimed.

## Deferred saved transcript placement

- Keep requested numeric scroll restoration pending instead of letting a loading
  placeholder clamp/consume it. Place after layout only when the selected native
  transcript projection and its mounted anchor registry are available.
- Fence pending placement to page/resource and, when already resolved, native
  session identity. A route/session mismatch drops it; cached matching native
  projections may be displayed without claiming fresh/atomic observation.
- Preserve the requested position during rapid back/forward navigation before
  data arrives. Explicit row reveal supersedes pending numeric placement;
  help/palette defer it and cleanup discards it. Reading-anchor/bottom sampling
  is suspended while placement waits, then starts from the restored position.
- Clamp only against the rendered current window. This does not load older
  history, persist a text-line/follow-mode anchor, restore every asynchronous
  resource screen, or establish original frozen-window/timeline parity.
- Draft, native ingress, ownership, provider and protocol bindings are unchanged.
  No renderer/mounting/snapshot/presenter tests or visual acceptance are claimed.

## Original latest affordance

- Restore the one-row right-aligned “Jump to latest ↓” affordance between
  transcript content and the prompt, with original muted/primary hover text.
  The row remains allocated at the bottom; the label appears only when the
  sampled current-window viewport is away from the bottom.
- A guarded tap queues viewport intent for the currently selected native session.
  Apply after layout, clear pending numeric/reveal placement and resume bottom
  following. Navigation, registry reset, superseding reveal, identity mismatch
  and cleanup discard stale intent; help/palette cannot activate it.
- The pointer action does not change selection/focus, clear a draft, admit work,
  adopt standalone identities, fetch history or promise a fresh observation.
  It targets only the currently supplied transcript window. Native protocol,
  command admission and provider/environment behavior remain unchanged.
- `/latest` preparation/routing, keyboard/timeline controls, frozen/load-older
  history and visual interaction verification remain unfinished. No renderer,
  snapshot, helper or navigation-matrix tests are added.

## Preparation-only `/latest` command

- Add `/latest` to the native transcript palette/suggestion catalog and help
  command text. Palette, pointer, Enter/Tab preparation and draft protection
  retain their existing behavior: selecting a suggestion does not jump or submit.
- A later explicit `/latest` submission accepts no arguments and requires a
  currently available native transcript with supplied data and mounted viewport.
  It queues the same identity-fenced local jump as the pointer affordance, clears
  only its accepted command text and records local accepted-input history.
- Permit exact `/latest` while an earlier submission is pending, like the existing
  narrow abort/refresh exception. This admits no native work and does not loosen
  other busy/mutation guards; pending-submission accounting remains unchanged.
- Invalid/missing scope and unsupported standalone UUID modes refuse without
  adopting/opening a conversation, fetching history or forwarding the command as
  model input. No protocol, provider, approval or environment behavior changes.
- Keyboard/timeline controls, frozen/load-older windows and visual verification
  remain unfinished. No renderer, snapshot, helper or navigation-matrix tests
  are added; public-boundary checks do not establish visual parity.

## Bounded frozen retained window

- While the sampled viewport is away from the bottom, retain the already supplied
  native entry window rather than replacing it on incoming commits. Cache at
  most 200 entries, reset on missing projection/native identity change and release
  when following resumes. No older entries are fetched or fabricated.
- Keep current native progress separate from held retained history. Explicitly
  label the frozen window and explain that header usage/counters and live activity
  describe the separately supplied current projection. Pairing remains unique,
  identity/name-fenced and confined to the displayed retained window.
- Latest releases the held window before its requested layout jump. Existing
  native selection is not silently replaced if its row is absent after release;
  the supplied window's existing missing-selection warning remains authoritative.
- This is bounded in-memory presentation, not persisted native history or an
  adopted session. Original load-older/timeline behavior and simultaneous reader
  movement/publication still need work. No renderer/presenter tests or visual
  acceptance are claimed; no native permission/protocol/provider changes occur.

## Explicit pointer reading intent

- Observe eligible bubbling vertical wheel gestures and primary down/drag events
  originating in the shared vertical scrollbar. Preserve OpenTUI's native pointer
  handler: do not provide a scroll delta, prevent default or stop propagation.
- Mark reader intent for the currently available native transcript identity.
  Supersede pending latest/numeric/reveal placement; where already movable, hold
  the bounded supplied retained window before the next layout publication.
- The next eligible post-layout sample treats this as reader motion even if
  geometry changed concurrently, so the prior anchor/bottom-follow correction
  cannot overwrite the gesture. Resample the actual clamped position normally.
- Latest, explicit reveal, identity/navigation/registry reset, overlays and cleanup
  discard stale intent. Horizontal gestures and non-scrollbar primary taps do not
  create it. No native work or authority is inferred from pointer activity.
- This does not establish complete simultaneous-scroll/reflow parity: keyboard,
  selection-autoscroll, non-bubbling gestures and text-line displacement still
  need verification/work. No renderer/helper/presenter tests or visual acceptance
  claims are added; native protocol, permissions and provider behavior are unchanged.

## Original transcript viewport keys

- Restore PageUp/PageDown and Ctrl+U/Ctrl+D for an available native transcript
  in content focus, using the original one-third-terminal-height step (minimum
  one line). The viewport layer is inactive for breadcrumb/sidebar focus,
  settings editing, help/palette overlays and non-native/standalone views.
- Effective movement supersedes pending viewport placement and marks the same
  identity-fenced reader intent as pointer gestures. Synchronize OpenTUI's manual
  scroll state through the original scrollBy/scrollTo sequence, then resample
  clamping after layout instead of inferring reader intent from geometry alone.
- Consume boundary keys without modifying the viewport/follow state. Preserve
  selection and unsent draft; no model input, native task or history fetch occurs.
  Read-only scrolling remains available while an earlier submission is pending.
- Include the bindings in shared transcript help and footer; unregister the layer
  on cleanup. Selection-autoscroll, text-line anchoring, timeline/load-older and
  visual interaction verification remain unfinished. Public-boundary checks are
  not visual acceptance; no renderer/helper/presenter tests are added.

## Complete message-block reading registry

- Register existing user-prompt, non-assistant message and assistant prose boxes
  in the bounded transcript reading registry, alongside thinking/tool headers.
  User rows use a separate reading identity namespace; prose uses its existing
  native part identity. No extra wrapper, spacing, border or render service is
  introduced, and no reading-only row enters the card selection/Enter catalog.
- Dispose refs with their message/part owners and guard replacement cleanup by
  mounted-node identity. Missing or replaced identities do not silently select
  a successor or adopt any native conversation/task.
- Sampling and held-anchor correction require a positive-height, finite-position
  row attached to the current scrollbox through visible, non-destroyed ancestors.
  Detached rows and hidden ancestor subtrees cannot anchor the current viewport.
- This improves block-level anchoring while reading prose/user messages; it does
  not provide text-line/source-offset anchoring, timeline/load-older or visual
  acceptance. No renderer/presenter/helper tests are added, and native protocol,
  permissions, pairing, draft/admission and provider behavior remain unchanged.

## Local navigation follow-mode restoration

- Remember the sampled native transcript's bottom-follow preference as small,
  data-only local view detail, fenced by the resolved native conversation ID.
  Queued latest requests preserve following intent; effective reader/reveal
  requests preserve numeric-place intent. Unobserved/missing scopes do not
  manufacture a follow preference.
- Back/Forward and local memory bookmarks retain this through their existing
  cloned view snapshots. A pending deferred restore preserves the requested
  detail/top during rapid navigation rather than sampling a loading placeholder.
- Apply matching follow intent only after the guarded projection/registry/layout
  restore is ready, placing at the current supplied window bottom. Older or
  mismatched metadata keeps the existing clamped numeric restore and normal
  subsequent viewport sampling. Draft/selection/authority are not replaced.
- Frozen entries are not saved or fetched. Native pinned viewpoints omit general
  local detail; their optional closed UI-only `transcriptFollow` DTO carries the
  fenced preference. Older pins retain numeric-only behavior. Revision, owner,
  approval and native admission contracts are unchanged. No renderer/helper tests
  or visual acceptance claims are added. Timeline/load-older, selection-autoscroll
  and text-line anchoring still remain unfinished.

## Native owned-selection autoscroll sampling

- Observe OpenTUI's existing dragging selection only when its visible,
  non-destroyed container belongs to the current available native transcript's
  scroll content. Do not inspect/copy selected text, change selection, install
  selection listeners or replace native autoscroll/clipboard behavior.
- Actual viewport movement during that owned drag counts as reader motion even
  alongside geometry changes. Retain only the same selection object/native ID
  for the next eligible sample to cover its release frame when the object remains;
  static selections and unrelated/new selection objects do not imply movement.
- Navigation/registry reset, overlays, identity mismatch, explicit latest/reveal
  or other reader intent and cleanup discard the retained observation. Standard
  clamped sampling/freezing/follow behavior remains responsible for placement.
- This is bounded detection, not complete selection/autoscroll parity: escalated
  cross-pane containers, destroyed/cleared selection objects, first-event ordering
  and text-line displacement remain unverified. Timeline/load-older and visual
  acceptance are still unfinished. No renderer/helper tests or native authority,
  protocol, provider or draft/admission changes are introduced.

## Retained SDK read annotations

- Keep the existing exact separately recorded harness-footer removal. For SDK
  truncation, split file prefix from notice only when retained truncation content,
  output-line metadata, requested start and complete continuation suffix agree.
  Validate safe line/next-offset bounds; show the notice separately as inert,
  metadata-matched SDK-style text, never as a numbered file line or action.
- Ambiguous/unmatched truncation, first-line-limit notices, image-associated text
  and continuation-shaped tails without corroborating metadata remain verbatim
  plain retained text with unavailable line provenance. A literal file tail that
  resembles a notice is not silently removed. Full retained output/details remain
  available through the existing output/details folds.
- Normal retained read bodies retain original file presentation. No live read,
  synthesized patch, sed/offset execution, continuation fetch, provider call or
  native authority is introduced. Metadata does not prove a fresh file snapshot.
- This is conservative provenance handling, not complete SDK tool-view parity.
  Timeline/load-older, text-line anchoring and visual verification remain open;
  no renderer/helper/presenter tests or visual acceptance are claimed.

## Native pinned follow preference

- Extend only the closed UI bookmark DTO with optional `transcriptFollow`:
  positive safe native ID and boolean `following`, no additional nested keys.
  Permit it only on the canonical orchestrator view or a numeric session resource
  matching that ID; standalone/resource-family uses and malformed fields refuse.
- Pin/repin sample current viewport memory before serializing. Only matching
  native identity metadata is included. Cached native pins translate this narrow
  DTO into local follow detail with an empty draft; all other local details remain
  omitted. Restoring still waits for the matching available transcript/layout and
  cannot open/adopt native work or assert that an ID is currently catalog-owned.
- Existing pins without the optional field remain valid without migration.
  Authenticated public-boundary fixtures cover true/false persistence/reopen,
  malformed/foreign-page fields, stale deletion and unchanged task/schedule state.
  General drafts, logs, confirmations and execution extras remain refused.
- This extends UI-only wire data, not native authority. Timeline/load-older and
  complete selection/text-line parity still remain open; no renderer/helper tests,
  live provider/environment activity or visual acceptance are introduced.

## Retired history-read scope handling

- Existing explicit retained-history explorer clears its local pending latch on
  connection/client/conversation scope changes together with entries and cursor.
  A new scope may initiate its own explicit read without waiting for a retired
  scope's network request to settle.
- Capture client identity, native conversation ID and local epoch for each read.
  Only a still-connected matching scope may publish entries/cursor/errors or clear
  its pending latch. A retired completion cannot unlock a newer pending read.
  A current-scope response with the wrong native ID refuses instead of silently
  adopting it or leaving an unexplained result.
- Scope changes do not cancel native work, retry requests, page automatically,
  adopt contexts or merge history into the main transcript. Existing bounded
  retention and explicit newest/older controls remain unchanged.
- No helper/renderer/mounting tests are added. Existing authenticated functional
  gates are rerun; interactive request-order behavior remains unverified. This is
  explorer scope safety, not original integrated load-older/timeline parity.

## Shared original read-only modal frame

- Extract the already ported GenericModal read-only frame from HelpModal into
  local `ReadOnlyModalFrame`: same absolute portal/z-index, dim backdrop,
  centered mantle surface, padding, header/content/footer order and footer box.
  Caller-provided width/height and footer budget retain HelpModal's sizing.
- Preserve exact primary backdrop tap classification, down/up ownership checks,
  dialog mouse-up suppression and backdrop wheel suppression. HelpModal retains
  its original header, wrapped rows, wheel behavior and help-chip callbacks.
- The frame owns no keymap, drafts, confirmation state, command dispatch, global
  selection-copy hooks, timer or native runtime references. It is presentation
  groundwork for the original list/timeline picker rather than a new design.
- Timeline items/filtering/selection, native identity-bound prompt jumps and the
  remaining ScrollableList behavior are not implemented by this extraction.
  No renderer/helper tests or visual acceptance are claimed; existing functional
  gates are rerun, not used as evidence of presentation parity.

## First supplied-window timeline picker

- Explicit `/timeline` (no arguments) opens a bounded snapshot of user prompts
  in the mounted supplied native transcript window. Palette/slash preparation is
  inert until submission. Standalone/non-native/unavailable/loading scopes refuse;
  an empty user-prompt window shows the original `No user messages to show.`.
- Port the original cap modal dimensions, `Jump to message` header, selection
  marker and selected/hover row fills with one-line prompt labels. j/k and arrows
  navigate; Enter activates, Esc/backdrop dismiss; primary row gestures use the
  original shared row policy and wheel movement remains local to the picker.
- Prompt preview registration is fenced by the reading registry instance. Snapshot
  labels are bounded to 200 prompts/512 code points each. Selection uses the
  captured prompt identity, never a polling position; deleted/detached targets
  refuse without replacement. Modal scope retirement clears the snapshot.
- A successful activation queues an explicit top-aligned prompt reveal through
  the existing post-layout path, fenced again by native ID/page/resource and
  attached visible row. It changes viewport placement only, not card selection,
  unsent drafts, native context, authority or retained history. No fetch is made.
- This is the first timeline subset, not complete ListViewModal/ScrollableList
  parity. Filter prompts, original timestamp/index details, footer-chip activation,
  scrollbar/indicator behavior and integrated load-older remain unported. No
  renderer/helper/mounting tests or visual acceptance are claimed.

## Local timeline filter and original prompt order

- Restore the original newest-first timeline order and 160-code-point one-line
  preview budget (159 plus ellipsis when truncated). Captured native identities
  and supplied rows are not mutated; no timestamp is synthesized.
- `/` enters the original local filter mode. The shared search header displays
  the active query/cursor and, after Enter leaves filtering, the result count.
  The original `Filter prompts` placeholder was a search-enable flag rather than
  visible placeholder text; this port uses the same SearchHeader branch directly.
- Restore original filtering help (`Type`/Filter query, Enter/Done filtering,
  Esc/Dismiss filter). Enter leaves filtering without jumping; a subsequent
  explicit Enter activates. Esc clears the query and exits filtering without
  dismissing the picker; a subsequent Esc dismisses it. j/k type into the query
  while filtering and navigate otherwise. Backspace removes one code point.
- Port the original finite alphabet/Enter spelling coverage through an active
  modal keymap layer, not a global keyboard listener or hidden editor. No paste,
  IME, arbitrary Unicode query alphabet or complete editor support is claimed.
  Queries are bounded to 256 code points and match displayed labels locally.
- Preserve selected prompt identity across filtering, unlike the original index
  reset: hiding it leaves no activation target until explicit row navigation or
  selection. Filter changes retire pending pointer/double-tap state. A refused
  activation gets a reserved one-line footer instead of a clipped content row.
- Native reveal/scope fences remain unchanged. Footer-chip activation, retained
  timestamp details, scrollbar/indicator and load-older remain unfinished. No
  renderer/helper/mounting tests or interactive/visual acceptance are claimed.

## Timeline range row and safe footer chips

- Restore the original centered, muted `Showing a–b of n` row for nonempty
  supplied lists, including filtered lists. Reserve its line before calculating
  the visible prompt window; omit it with the original empty state. Counts refer
  only to the supplied/filtered snapshot, not complete native retained history.
- Wire the unambiguous `/`, Enter and Esc HelpText chips through the same local
  control handler as their keyboard equivalents. Enter while filtering only
  finishes filtering; Esc clears/exits filtering before it can dismiss the modal.
- Combined `j/k` and `Type` hints stay informational: a tap cannot invent a
  direction or text input. Shared tap/hover semantics remain in HelpText. Chip
  activation requires the active surface and exact current footer entry, so a
  retired mode/width entry cannot acquire a new meaning on release.
- Native prompt identity/reveal fences, draft protection and bounded supplied
  data are unchanged. No fetch, admission, timer, clipboard hook or authority is
  added. Full scrollbar interaction, timestamp details and load-older remain
  unfinished; no renderer/helper tests or visual/interactive acceptance claimed.

## Recorded timeline clock details

- Carry only a valid, nonnegative finite millisecond timestamp already present
  on a retained user message into its captured UI-only prompt row. Omit absent,
  string, negative, nonfinite and out-of-Date-range values. No native entry/task
  time, seconds conversion, current clock, timer or inferred start is substituted.
- Restore the original muted, nonshrinking right-edge clock detail beside the
  truncated prompt label, using the existing pure original clock formatter and
  explicit row composition. Local filtering considers the displayed clock detail
  as in the original picker; the finite query-key alphabet is unchanged.
- Timestamp metadata does not enter navigation/bookmark persistence, admissions,
  native identity or ownership. Captured rows and existing reveal/refusal fences
  remain intact. A recorded clock is not claimed to establish native task timing.
- Full scrollbar interaction and integrated load-older remain unfinished. No
  renderer/helper tests or interactive/visual acceptance are claimed.

## Original passive timeline scrollbar and mouse-out composition

- Restore the original one-column track/thumb beside the clipped row window,
  only when filtered prompts overflow. Use the original floor-proportional thumb
  top, ceil-proportional minimum-one-line height, theme colors and collapsing
  lower track. Empty/nonoverflowing lists have no scrollbar.
- The fixed-height list row owns wheel movement for both prompt rows and the
  adjacent scrollbar. No thumb drag, track click, fetch or new selection/admission
  behavior is invented: the original ScrollableList scrollbar is passive.
- Match the original row handler composition: construct hover with the shared
  row mouse-out callback and spread hover after row handlers. Leaving a row now
  clears hover and retires its gesture together instead of overriding one handler.
- Identity/refusal/reveal fences, filtered range and footer budgets are unchanged.
  Integrated load-older, full original list extraction and interactive viewport
  verification remain unfinished. No renderer/helper tests or visual acceptance
  are claimed.

## Timeline captured-row replacement fences

- Capture the mounted reading registry and exact prompt row objects alongside
  the bounded timeline labels when `/timeline` opens. The existing native key
  remains necessary but is no longer sufficient: retained byte changes can
  replace a mounted row while preserving that key.
- Activation now requires the same registry, captured row and current registry
  mapping, in addition to native ID/page/resource, attachment and availability.
  A replacement refuses without adopting its new row or label.
- Carry the registry/key fence into the deferred post-layout reveal and recheck
  it before scrolling. Scope/reset retirement still clears queued reveals. A
  reveal rejected before queueing does not dismiss the picker or clear reader
  placement; ordinary card reveal callers retain their existing behavior.
- Captured renderables are ephemeral UI-only references, not serialized bookmark
  state, retained native data or execution authority. No history paging, implicit
  reopen/retry, model call or native admission is added. Integrated load-older
  and interactive/visual acceptance remain outstanding; no renderer/helper tests.

## Shared original fixed-row read-only list branch

- Extract the timeline's original fixed-row window, row mouse/hover composition,
  wheel owner and passive scrollbar into local `ReadOnlyScrollableList`. The
  calling picker still owns its bounded unique items, native-key selection,
  start position, filter, gesture holder, modal chrome and range/footer budget.
- Keep the same list/row box dimensions and child order; row rendering receives
  a reactive selection accessor without an added layout wrapper. Timeline marker,
  label/clock rendering, selected fill and empty content remain owned by the
  timeline. No renderer, runtime or legacy delegation is introduced.
- Retired items cannot activate through a stale row index; the current item at
  that index must still be the rendered item. An absent item never becomes
  selected merely because the owner has an unavailable (-1) selection.
- This is the fixed-height, unique-item read-only branch, not the original full
  variable-height/keyed-occurrence ScrollableList API. No editor, filter input,
  data fetch, native command or persistence is owned by the shared component.
  Integrated load-older and interactive/visual acceptance remain outstanding;
  no renderer/helper/mounting tests are added.

## Shared list gesture retirement across pauses/replacements

- Retire the shared list's local pending press and last-tap record when its
  active state changes, its item array is replaced, or the list unmounts. A tap
  begun before an overlay pause cannot regain activation meaning after resume.
- Ordinary selected-index and window-start changes do not retire the holder;
  keep the original row-instance/cell rules across window movement. Current-item
  equality and native timeline captured-row/reveal fences remain unchanged.
- This is local pointer bookkeeping only: no global selection/clipboard hooks,
  native cancellation, command, retry, fetch or persisted state is introduced.
- Load-older remains a separate unfinished path: the original local expansion
  of supplied blocks must not be misrepresented as permission for automatic
  native `session.history` reads on scrolling. No renderer/helper tests or
  interactive/visual acceptance are claimed.

## Timeline backdrop follows filter-first dismissal

- Route a classified primary backdrop tap through the same guarded local Esc
  action as the keyboard/footer chip. While filtering, it clears the query and
  dismisses filtering first; a subsequent backdrop tap closes the picker.
- Preserve the original picker backdrop hierarchy rather than calling the parent
  close callback directly. An inactive picker cannot dismiss through this path.
  Existing drag/nonprimary rejection remains owned by ReadOnlyModalFrame.
- No native action, draft modification, history fetch or new pointer listener is
  added. Integrated load-older and interactive/visual acceptance remain unfinished;
  no renderer/helper tests are added.

## Codemode supplied JavaScript source body

- Restore the original codemode source discriminator (`arguments.code` as a
  string) in the local requested-source body. Render the exact supplied bytes
  as highlighted JavaScript, retaining the existing independent source fold
  and partial/live-slot/retained-intent caveats.
- Missing/non-string code does not synthesize a script. Arguments and native
  result/details remain available through their existing read-only bodies.
- This is source presentation only, not the complete original codemode view:
  do not reconstruct nested calls, elapsed time, interruption, completion or
  counts from output strings. Native nested-slot and pairing rules remain the
  only authority for those observations; no execution or replay is introduced.
- Remaining specialized families, integrated load-older and interactive/visual
  acceptance remain unfinished. No renderer/helper tests are added.

## Codemode original header gutter and source headline

- Restore the codemode view's lambda gutter and first meaningful source line
  as its header subject. Follow the original discriminator: skip blank lines
  and `// @…` configuration lines, not arbitrary comments or script statements.
- Bound the single-line UI preview to 160 code points (159 plus ellipsis when
  truncated). Whitespace normalization affects only this preview; the source
  body and raw Arguments remain verbatim. Missing/non-string code retains the
  generic tool-name fallback; an empty/config-only string has the `script` subject.
- Do not copy the original pending `Executing` label into a native generated-call
  projection. Existing partial/live/retained status and native pairing rules
  remain authoritative; no elapsed time, nested call count or execution status
  is inferred from the source preview.
- The full codemode/nested-call layout, integrated load-older and visual/interactive
  acceptance remain unfinished. No renderer/helper tests are added.

## Codemode explicit retained script-output section

- Add the original codemode script-output body as an independently folded local
  section, only for a matched retained codemode result whose `details.output`
  is a string. Partial generated calls, live-only slots and ambiguous/missing
  pairings do not qualify. An explicitly empty string shows the empty-output
  message rather than falling back to arbitrary native result text.
- Preserve nonempty output verbatim. Missing/non-string output fields do not
  synthesize a section, parse text, strip status prefixes or reconstruct calls.
  Complete retained output and native Details remain available unchanged.
- The section's caption explicitly disclaims completion/nested-call authority.
  No command, model call, provider request, execution, retry or native mutation
  is added; source/headline/native slot observations retain their existing fences.
- Full nested-call layout, other families, integrated load-older and interactive/
  visual acceptance remain unfinished. No renderer/helper tests are added.

## Dialogue supplied question/context bodies

- Restore read-only supplied-question sections for `developer_question` and
  `agent_ask`, using the original nonblank string `question`/`description`
  discriminator and optional string context. An explicit `questions` array
  takes precedence over the single argument form; invalid/nontext items are
  omitted without inventing question text or falling back to result parsing.
- Keep original array positions for the local fold labels, including gaps for
  omitted items. These positions are UI labels, never response identities.
  Question/context bytes remain verbatim; partial/live-only sections are labeled
  as such and do not claim the question has been admitted or delivered.
- No result parsing, option/answer pairing, clickable responses, clarification
  routing or approval controls are introduced. The caption explicitly disclaims
  active clarification authority; raw Arguments/output/Details remain available.
- Full original dialogue and nested-call composition, integrated load-older and
  visual/interactive acceptance remain unfinished. No renderer/helper tests.

## Dialogue supplied options and options-only questions

- Add passive original option markers, explicit recommendation stars and
  descriptions beneath the supplied question/context. Use the original typed
  title → label → value fallback; an explicitly empty preferred label suppresses
  that option rather than silently choosing a lower-priority label.
- Recommendations require literal `true`; labels and nonblank description bytes
  remain verbatim. No option value matching, result response pairing or selected
  answer marker is introduced. The caption distinguishes supplied recommendations
  from selected answers, and option rows have no answer/approval handlers.
- Keep valid options-only or nonblank-context-only questions instead of dropping
  them for missing question text. Show the absence annotation, not invented text;
  invalid/empty items retain their original positional gaps in local fold labels.
- Full original dialogue detail folding/answer composition, nested calls, integrated
  load-older and interactive/visual acceptance remain unfinished. No native calls,
  clarification/approval routing or renderer/helper tests are added.

## Dialogue recorded identifiers and independent option detail folds

- Preserve a supplied string question `ident` as the original bracketed prefix,
  without trimming, inferring a fallback identifier or treating it as a native
  clarification identity. Missing question text retains its absence annotation.
- Restore independently disclosed option descriptions instead of always drawing
  them beneath each passive option. Use the existing local fold/toggle framing;
  no selection/answer handlers are attached to the offered option itself.
- Detail fold keys use the tool-call scope plus original question/option array
  positions (including omissions), not label/value matching. Duplicate offered
  labels therefore do not alias detail folds. Disclosure state is UI memory only,
  never an answer, response pairing, authority or provider operation.
- Full response/clarification composition, nested-call layout, integrated load-older
  and visual/interactive acceptance remain unfinished. No renderer/helper tests,
  native answer/approval controls or runtime calls are added.

## Dialogue supplied-question header subjects

- Restore the original dialogue header subject: one displayable item's supplied
  question text (or the generic `question` subject for options/context-only data),
  or a count of multiple displayable supplied items. No valid supplied items
  retains the generic tool-name fallback.
- Bound the single-item preview to 160 code points (159 plus ellipsis when
  truncated). Whitespace normalization applies only to this header preview;
  question/context/option bodies, identifiers and raw Arguments stay unchanged.
- Counts describe only displayable supplied items, not admitted/delivered questions
  or responses. Keep the existing generated/live/retained status caveats; do not
  infer an `asking` status, requester authority, result answer or clarification
  identity from this subject. No native operation or response routing is added.
- Full dialogue response composition, nested-call layout, integrated load-older
  and interactive/visual acceptance remain unfinished. No renderer/helper tests.

## Extracted local read-only ToolDialogue presentation

- Move the supplied dialogue row/detail JSX into local `ToolDialogue`, with a
  narrow readonly UI-byte shape and the owning card's phase/open/fold callbacks.
  Keep the exact row order, markers, caveats, indentation, colors and disclosure
  suffixes without an added layout wrapper or new pointer policy.
- ToolCard still owns argument projection, header previews, native status/pairing
  and disclosure state; ToolDialogue neither accepts native result records nor
  parses/matches responses or routes clarification/approval operations.
- Readonly question/option indexes are local presentation positions only. Existing
  empty/missing text handling and explicit source bytes remain unchanged. No
  legacy/runtime imports, global listeners or authority hooks are introduced.
- Full response and nested-call composition, integrated load-older and interactive/
  visual acceptance remain unfinished. No renderer/helper tests are added.

## Missing-diff edit request fragments

- Restore supplied edit-request detail when no native diff is retained: each
  record in an explicit `arguments.edits` array with string old/new fields gets
  an independent local replacement fold. Keep original positions through omitted
  invalid/incomplete records; never default missing fields to empty strings.
- Render old/new fragments verbatim in separate source blocks, including explicit
  empty-string annotations. Unlike an applied unified diff, these blocks have no
  inferred hunk headers, file positions, current-file reads or execution claims.
- Label partial/live-slot/retained requested intent distinctly. Existing no-diff
  warning, native status/pairing, complete Arguments/output/Details and supplied
  native diff presentation remain unchanged. No edit operation is dispatched.
- Direct single-replacement schemas, full specialized/nested-call composition,
  integrated load-older and visual/interactive acceptance remain unfinished.
  No renderer/helper tests or native/provider calls are added.

## Native single-object and top-level supplied edit forms

- Inspect the installed native `createEditTool` contract: it accepts array edits,
  a single edit object and top-level old/new fields while preserving original
  arguments. Display supplied single-object/top-level string pairs alongside
  array fragments without importing or executing its argument-repair machinery.
- Keep array disclosure suffixes stable; single-object and top-level forms use
  distinct local suffixes/labels. Both forms may be shown when both are supplied:
  this represents raw intent, not the SDK's prepared/merged operation or outcome.
- Stringified `edits` remain opaque in complete Arguments, even though the SDK
  can prepare them. Missing/non-string pairs produce no fragment; all displayed
  bytes and explicit empty-string annotations retain the prior fidelity policy.
- No normalization, parsing, deduplication, applied diff, file read, operation or
  authority is inferred. Specialized/nested-call composition, integrated load-older
  and interactive/visual acceptance remain unfinished. No renderer/helper tests.

## Supplied write-content fidelity

- Render the specialized requested write body only for an explicit string
  `arguments.content`. Missing, null and other non-string values remain in
  complete Arguments and produce an unavailable-content caveat, not fabricated
  empty write bytes. Explicit empty strings receive a distinct passive annotation.
- Preserve the existing FileContent body, path-based syntax and partial/retained
  labels. Label unlinked live-slot write bytes as supplied current-round content,
  not retained intent or a live-file snapshot. None of these bytes prove a write.
- Native status/pairing, file operations and disclosure authority are unchanged.
  No renderer/helper tests or filesystem/provider operations are introduced;
  integrated load-older and interactive/visual acceptance remain unfinished.

## Supplied shell-command and timeout fidelity

- Keep the requested Bash syntax body only for explicit string command bytes.
  Missing/non-string commands receive an unavailable caveat; explicit empty
  strings remain displayable with a distinct passive annotation. Complete
  Arguments remain the source for other values; no command is reconstructed.
- Label partial generation, unlinked live-slot source and retained request source
  separately. An absent timeout is not presented as a known native default;
  only supplied finite numbers receive a timeout value label, without asserting
  that the timeout was valid, admitted or used. Other values stay in Arguments.
- Retained/live bounded output, dropped-byte/line notices and native status/pairing
  remain unchanged. No shell execution, renderer/helper tests or authority changes
  are introduced. Alias composition, integrated load-older and interactive/visual
  acceptance remain unfinished.

## Original pending shell aliases

- Restore the original pending/live `shell` and `execute` family alongside Bash:
  supplied string command bodies and bounded observed-output tails share the
  existing shell presentation while no terminal result is linked. Partial calls
  still cannot display an execution-output preview.
- Retain the command/timeout fidelity guards and the native dropped-byte/line,
  uncertainty and live-slot notices. Output expansion shows supplied bytes only;
  alias recognition neither authorizes execution nor reconstructs a command.
- Follow the original terminal-family distinction: recorded `shell`/`execute`
  results remain generic structured/text views, not reclassified Bash results.
  Native pairing/status, output/details folds and non-text content are unchanged.
- No renderer/helper tests or execution operations are added. Integrated
  load-older, nested-call composition and interactive/visual acceptance remain
  unfinished.

## Extracted local requested-source presentation

- Move the supplied JavaScript/SQL source fold into `ToolRequestedSource`, with
  a readonly UI-byte shape and the owning card's phase/syntax/open/fold inputs.
  Preserve source bytes, language, labels, caveats, wrapping and `:source`
  disclosure suffix without an added layout wrapper or new event policy.
- ToolCard retains source/header projection, native pairing/status, exact scoped
  disclosure state and independent retained script-output gating. The extracted
  component accepts no native result or progress records and performs no parsing,
  execution, response matching, nested-call reconstruction or authority routing.
- No renderer/helper tests, legacy/runtime imports or new global listeners are
  introduced. Integrated load-older, nested-call composition and interactive/
  visual acceptance remain unfinished; structural checks do not establish parity.

## Extracted local requested-edit presentation

- Move the supplied replacement rows into `ToolEditRequest`, with readonly
  display keys/labels/old/new bytes and owner-created phase/syntax/open/fold inputs.
  Preserve row order, fragment bytes, empty-string annotations, plain-text syntax,
  caveats and exact disclosure suffixes without a new layout wrapper or listener.
- ToolCard retains argument projection, array/single-object/top-level distinctions,
  native diff gating/warning and scoped disclosure state. The component receives
  no result/progress records, native file identities or edit-operation handles;
  it neither parses repairs nor infers an applied diff, file range or outcome.
- Complete Arguments/output/Details and retained native diffs are unchanged.
  No renderer/helper tests or native execution are added. Integrated load-older,
  nested-call composition and interactive/visual acceptance remain unfinished.

## Invalid supplied read-offset provenance

- Require an omitted SDK-default offset or an explicit positive safe integer
  before showing read text with file-line numbering or splitting a matched
  continuation annotation. Invalid supplied values are never coerced to line 1.
- Preserve the retained read body verbatim and unnumbered when offset provenance
  is unavailable, using the existing unavailable-provenance caveat. Error output,
  exact separately recorded diagnostic-footer handling and complete Arguments/
  output/Details remain unchanged. No live file read or continuation is requested.
- No renderer/helper tests or native operations are introduced. Integrated
  load-older, nested-call composition and interactive/visual acceptance remain
  unfinished; static checks do not establish presentation parity.

## Compact shell-tail clipping annotation

- Retain the original ten-row command/separator/output preview budget, compact
  width handling and expanded supplied-byte presentation. Correct only its local
  clipping annotation: a partially clipped long line is not a complete omitted
  line, so character-clipped tails use `earlier text` rather than a fabricated
  exact earlier-line count. Whole-line-only clipping keeps its local line count.
- These annotations describe the display window, never native dropped lines or
  capture truncation. Existing native dropped-byte/line notices, retained/live
  provenance and error coloring remain independent and unchanged.
- No renderer/helper tests, native calls or new interaction policy are added.
  Integrated load-older, nested-call composition and interactive/visual acceptance
  remain unfinished; static checks do not establish viewport behavior or parity.

## Extracted passive browser sections

- Move the retained observation/match section JSX into `ToolBrowserObservation`,
  with readonly section keys/display values and owner-created open/fold callbacks.
  Preserve section order, labels, recorded-ref caveats, structured/text branches,
  colors, wrapping and exact disclosure suffixes without a new layout wrapper.
- ToolCard retains structured-result projection, native pairing/status and scoped
  disclosure state. The component neither parses results nor resolves recorded
  refs, opens browser sessions, dispatches actions or routes authority fields.
- Complete retained output and non-text content remain unchanged. No runtime/
  legacy imports, global listeners or renderer/helper tests are introduced.
  Integrated load-older, nested-call composition and interactive/visual acceptance
  remain unfinished; this extraction does not establish visual parity.

## Multipart retained structured-output fidelity

- Require exactly one supplied text part before projecting a retained result as
  structured JSON. A JSON-shaped first part no longer replaces the main display
  of later text parts; multipart bodies use the existing complete-text fallback.
  Do not concatenate parts into an invented structured result or discard extras.
- Browser observation/match sections follow the same conservative projection
  boundary. Single-text JSON behavior, complete output folds, non-text content,
  diagnostic handling and native status/pairing remain unchanged.
- No renderer/helper tests, result reconstruction or native operations are added.
  Integrated load-older, nested-call composition and interactive/visual acceptance
  remain unfinished; checks do not establish presentation parity.

## Batched read/write/shell body separation

- Extract all three remaining basic byte bodies together into local
  `ToolByteBodies`: retained read fragments/annotations/errors, supplied write
  content and supplied shell command/timeout presentation. Preserve existing
  labels, phase precedence, unavailable/empty distinctions, syntax, wrapping,
  order and layout without extra renderer wrappers or listeners.
- ToolCard retains family admission, valid read-offset/continuation projection,
  exact diagnostic-footer handling, native pairing/status, retained edit diff
  gating and all output/disclosure ownership. Body inputs contain only projected
  bytes/display values, paths, owner-proven read positioning and presentation
  flags—not native result/progress records, executable handles or client access.
- Reuse FileContent in the same owning hover context. Shell aliases remain
  pending-only; compact/live/retained output and native dropped-byte/line notices
  remain independent. No calls, repairs, file reads or result inference are added.
- This batch separates read/write/shell together, complementing the already local
  dialogue/source/edit/browser sections, with one full verification/commit pass.
  No renderer/helper tests are introduced. Integrated load-older, nested-call
  composition and interactive/visual acceptance remain unfinished.

## Integrated bounded local load-older batch

- Port the original 60/40 window/page cadence in supplied native-entry units:
  initially mount the newest 60, then expand by 40 within the existing last-200
  retained bound. This is local presentation only; it cannot fetch, merge or
  synthesize earlier native history. The independent HistoryPanel remains the
  explicit native paging boundary.
- Keep uniqueness and native call/result/live-slot matching over the entire
  bounded retained window. Consume result rows and live slots only for mounted
  calls: a retained result whose call is locally hidden remains visible as an
  unpaired local row, and an observed live slot stays independently visible.
  Mounted-card navigation, prose caches and prompt timeline membership use only
  mounted rows; their exact target/node guards remain in force.
- Upward keyboard/wheel intent at the scrollbox top expands locally, including
  another upward gesture when already at zero. Layout-only changes, downward
  motion, reveals, scrollbar taps, stopped events and owned selection drags do
  not independently authorize expansion. No new keybindings, modal or native
  command is added.
- Capture prepend restoration before mounting, then settle after layout using
  the exact surviving row/node and offset (height delta only without an anchor).
  Fence by session/page/resource, registry, scrollbox, paging controller and exact
  frozen window token. Latest, saved-position restore, modal state, replacement
  scopes and stale/destroyed rows prevent a pending prepend from taking over.
- Preserve an expanded local count across same-session updates, still capped at
  200; `/latest` collapses to the initial mount. Expand the same supplied bound
  before restoring a saved non-following numeric scroll position, so the smaller
  initial mount cannot silently clamp a previously expanded reading position.
- Labels distinguish retained bounds from mounted rows. This completes the local
  expansion/owner/viewport integration in one batch, not native-history merge,
  text-line/source-offset restoration or visual/interactive acceptance. No
  renderer, presenter or navigation-matrix tests are added.

## Batched workspace layout, host controls and viewpoint persistence

- Move expanding/permanent ownership from the sidebar component into the shell's
  view state. Ordinary route changes carry the preference; Back/Forward and local
  memory viewpoints restore their own cloned layout. Preserve the original
  6/34-column compact/expanded geometry and 150ms tween.
- Mount the same workspace presentation on the selected outer left/right side;
  mirror the original open/collapse glyphs by side. Each side mount registers its
  own key layer so retiring one cannot unregister the replacement. Native agent
  identities and workspace entry ordering remain unchanged: OpenCode, Pi,
  Pi Durable, Orchestrator, native children, viewpoints and feature resources.
- Restore the original Ctrl+S workspace/content toggle and Ctrl+H/Ctrl+L route
  cycle alongside existing aliases. These target workspace identities on either
  side, not physical panel indices. Cycles exclude child disclosure and unrelated
  viewpoint snapshots; pointer activation and host cycling share current route
  membership checks. Covered modals, editing and busy state refuse interaction.
  Ctrl+A is not newly claimed from standalone/input selection surfaces.
- `/workspace expanding|permanent left|right` explicitly changes only local
  display state. Palette/autocomplete entries prepare the four choices; submission
  validates exact arguments before clearing the draft. No config write, native
  provider call, session admission or execution occurs.
- Add an optional closed `UiView.workspace` layout to native viewpoints, with
  exact mode/side enums and refusal of missing/extra/execution-shaped fields.
  Native pin/repin capture it; UI-only restoration preserves it. Old native/local
  views lacking layout remain valid and use expanding/left on restoration.
  Persistence is through explicitly saved viewpoints, not a silent global config
  update or automatic bookmark adoption on startup.
- Extend the existing authenticated viewpoint fixture with all four layouts,
  invalid-shape/enum refusals, old DTO compatibility, read/reopen retention and
  unchanged native task/schedule assertions. No renderer/helper/navigation-matrix
  tests or visual acceptance claims are introduced. Resource filters, pin ordering
  beyond current observations and the remaining focus catalog still need work.

## Batched model/thinking profile choices and scoped preparation

- Extract the original cap-sized single-row model/thinking/timeline modal branch
  into local `ReadOnlyChoicePicker`: same half-width/90%-height frame, search
  header, selection marker, row colors, passive scroll indicator, j/k and arrow
  navigation, filter-first Escape/backdrop dismissal and footer gestures. Timeline
  keeps its reverse order, clock formatting, 160-codepoint label budget and exact
  App-owned mounted-node/registry reveal fences. Add digits, identifier punctuation
  and space to the modal's finite filtering alphabet; do not install an editor,
  global keyboard hook or paste listener.
- `/models`, argument-free `/model` and `/thinking` open choices from the supplied
  authenticated profile snapshot, never SDK discovery. Keep native profile IDs
  exact and reject duplicate identities and unsafe command tokens. Show model and
  declared thinking together, with observed availability marked as reported rather
  than probed or inferred. This native API configures profile bundles, not arbitrary
  models or independent SDK thinking overrides: thinking choices are restricted
  to supplied profiles for the exact observed/configured model.
- Model/thinking prompt labels now use original primary-tap classification to open
  these choices. Retire pending header gestures when view identity, labels or
  interactivity changes. Existing text, color, clipping and prompt composition stay
  in place; standalone model/usage labels are not invented from backend behavior.
- Choice activation only prepares `/model-for NATIVE_ID PROFILE` or
  `/standalone-model UUID@REVISION PROFILE`. Preserve an unsent draft, require the
  captured view identity and exact current profile observation, and fence native
  writability or standalone mode/scope/revision/readiness. Retire the chooser on
  navigation, disconnect or target loss/change rather than adopting another row.
  Palette/autocomplete still prepare commands for explicit submission.
- The explicit standalone command rechecks the observed UUID/revision and ready
  state before calling the existing native configuration API. No numeric alias,
  implicit current revision, session creation or uncertain replay is introduced.
- A client-only `stateFresh` observation distinguishes authenticated hello from a
  new-generation snapshot. Retained offline state remains readable, but these new
  selectors stay disabled until a fresh native snapshot arrives. This flag grants
  no permission and changes no gateway/HTTP schema, approval or execution path.
- Extend existing authenticated client/standalone fixtures with exact public
  profile bundle fields, inert reads, unknown-profile refusal, explicit ready
  configuration, revision advancement/stale refusal, no chat send during
  configuration, and reconnect freshness without mutation replay. No helper,
  navigation-matrix or renderer tests are added. These checks do not establish
  visual or interactive acceptance. Resource/run profile and argument pickers,
  full text-input behavior and remaining prompt actions still need work.

## Batched native workspace filters, task rows and scoped navigation

- Restore original Active/Attention/All chips, colors and sidebar-only `f`
  cycling. Filters apply only to native task rows: Active means an observed
  nonterminal native task; Attention means a supplied pending review for that
  exact task ID. All also retains terminal/unknown task observations. Do not
  classify execution from activity prose, tool names or legacy workflow states.
- Expose the already-read native task's scalar SDK status alongside existing
  activity/detail/outcome in the authenticated snapshot. Null means no native
  state observation; it is not a running/failed task. This adds no SDK lookup,
  command, ownership grant or new engine authority. Public fixture checks compare
  settled status with the SDK and held-review status with authenticated task.read.
- Adapt the original three-line expanded task row and compact numbered/status/
  metadata-initial composition locally. Expanded rows show exact native task ID,
  supplied skill/activity/detail and repository basename; warnings and terminal
  outcome tones use observed native fields. Compact positions are display only,
  never task or conversation identities. No timer, usage, phase or owner is inferred.
- Keep OpenCode, Pi, Pi Durable and Orchestrator as the four fixed leading pins;
  native children follow unchanged and remain outside task filtering. Add task
  rows before viewpoints/feature resources, which also remain available under
  every filter. Stable task creation ordering and native-ID tiebreaks avoid
  progress-driven reshuffling; duplicate/invalid task identities are omitted.
- Task activation targets the existing native task detail route, not a child
  conversation, standalone UUID or inferred session. Host cycling shares current
  filtered membership checks. Track mixed one/two/three-line row heights for
  keyboard reveal; keep identity selection when filtering removes its visible row
  rather than silently adopting the next task. Retire presses on view replacement,
  source/position/filter/layout/interactivity changes and cleanup.
- Add optional closed workspace.filter to UI-only viewpoints, retaining older
  mode/side DTOs and defaulting absent filters to Active in the shell. Layout
  changes preserve filtering; ordinary routes, Back/Forward and explicit local/
  native viewpoints carry it. `/workspace filter active|attention|all` and its
  palette suggestions change/prepare display state only, without a config write,
  task admission or draft submission. Existing authenticated viewpoint checks
  cover all filters on both modes/sides, invalid shapes, reopen persistence and
  unchanged tasks/schedules. No helper/renderer/navigation-matrix tests are added.
- Cached snapshots remain navigable but visibly disclaim current activity;
  connection-generation freshness is not an atomic per-task observation or action
  permission. Original resource/pin customization, richer phase/progress content,
  list virtualization and interactive/visual acceptance remain unfinished.

## Integrated standalone observation, navigation and prompt batch

- Compose Pi/OpenCode inventory rows with the original selectable chrome and
  supplied title, configured profile and native status. UUIDs stay independent
  of durable task/session IDs. Filtering uses supplied fields; `newest` reverses
  supplied inventory order, without inventing creation timestamps. A hidden or
  missing saved UUID never selects the next session automatically.
- Register inventory rows and retained user folds with the existing rendered
  control key layer (Ctrl+Alt+J/K and Ctrl+Alt+Enter), including viewport reveal.
  Primary taps share guarded navigation. Retire row presses on source, position,
  filter/order, view and interactivity changes. Opening another UUID uses normal
  route/Back/Forward state, not in-place resource reassignment; reselecting the
  current UUID preserves its draft and does not add duplicate history.
- Read inventory/detail through an explicit read-only client observation. Reject
  duplicate IDs, invalid revisions, wrong-mode/missing UUIDs, mismatched detail
  identity/repository/capabilities/scope and regressing revisions. Check the exact
  connection generation across both reads. This is bounded and non-atomic, not
  an ownership grant, backend probe or implicit session adoption.
- Scope panel reads to client, mode, UUID, view, connection and explicit refresh;
  coalesce invalidations while a read is pending and discard retired results.
  Ordinary input/cursor updates do not initiate reads. Disconnect/read errors
  preserve visibly cached content while withdrawing current-activity claims and
  prompt chooser freshness. Native reads may wait for an in-flight attempt;
  retained display is not a guaranteed live status feed. No uncertain
  send/configure/compact is redispatched.
- Key retained markdown caches by mode plus UUID and keep user folds for unchanged
  role/content at the same retained index during polling. Indexes are local
  display positions, not native message IDs. Source replacement or unmount still
  resets those local folds; this is not native-history merge or persisted folding.
  UserPrompt keeps its original raised/left-bordered chrome with scoped primary
  tap retirement and optional standalone keyboard registration.
- Integrate the observed standalone configured-profile label into prompt chrome.
  Fresh ready records may open the existing supplied profile-bundle chooser;
  cached, busy, uncertain or missing records cannot. The chooser only prepares an
  explicit revision-fenced command. Busy pulse uses observed native attempt
  activity, never completion. No standalone model, thinking, timing or lifetime
  usage is inferred from the limited retained-message DTO.
- Extend existing authenticated OpenCode/Pi boundary fixtures for inert scoped
  reads, wrong-mode/foreign refusal, retained redacted replies, ready/uncertain/
  closed observations and closed-client refusal. No renderer/helper/navigation
  tests, real model/provider calls, backend starts or visual acceptance are added.

## Integrated native environment picker and editor batch

- Reuse the original capped searchable choice frame for workbench operations,
  configured app/target fields and run/build/test target selection. Runtime
  profiles stay bundled with supplied target identities; no independent model,
  runtime or thinking overrides are invented. The root owns the overlay so the
  prompt, sidebar and underlying controls cannot acquire its keyboard input.
- Keep picker callbacks local: select an operation, edit JSON or prepare an
  explicit command. No discovery, inspection, task admission, backend start,
  preview or apply occurs on opening/selecting a picker. Existing unsent prompt
  drafts are not replaced. No request IDs, revisions, digests, inspection booleans
  or approvals are synthesized. Changing app explicitly removes the old target;
  other payload fields remain unvalidated and require separate review.
- Fence choices by exact view, supplied row membership, source bytes, freshness,
  local JSON/operation and pending state. Duplicate app/target IDs are not chooser
  candidates. Removed, changed, filtered or disconnected source observations
  cannot turn a retained choice into another target or owner. Inventory reads
  remain last-observed metadata, not readiness or lease authority.
- Scope workbench result/preview publication to client, resource, view and local
  epoch. Preserve draft memory across mounts without persisting it in viewpoints.
  Prevent unrelated cursor updates or editor-focus callbacks from invalidating
  an active editor. Body/mode/operation changes retire confirmations and stale
  results. Covered/pending editor and approval events cannot mutate local input;
  Enter in the approval field only leaves editing and never applies an intention.
- Correct the preview description: sealing stores exact immutable text, not a
  validated native payload. Validation occurs only on separately confirmed apply;
  even validation refusal consumes that intention. The manually typed exact
  unexpired `approve:<digest>` check and all native inner approval/ownership fences
  remain unchanged, with no automatic retry or restored approval.
- Port shared ActionHeader pointer activation to the original primary-tap rule:
  drags/non-primary buttons do not activate controls, nested row taps do not
  duplicate activation, and cleanup/scoped interactivity retires gestures.
  Keyboard registration remains presentation-only; callers retain all guards.
- Extend the existing authenticated native fixture for unsupported read fields,
  inert unvalidated sealing, consumed invalid payloads and changed-text digest
  mismatch. No helper/renderer/navigation tests or actual app operations are added.
  Full layout, lifecycle and terminal visual acceptance remain unfinished.

## Integrated resource workspace display-state batch

- Resource overview now uses the shared searchable choice frame for matching-row
  navigation, supplied category selection and inventory/identity ordering. Category
  labels come from observed environment kinds or schedule states, not invented
  readiness, activity or engine discovery. Text filtering remains an explicit local
  `/filter` command, prepared without replacing an existing draft.
- Add per-view display-only row pins and pinned-only filtering. Pins partition
  matching rows ahead of unpinned rows while keeping stable order within each group.
  Identity ordering supersedes `/sort`; inventory ordering respects it. Category,
  text and pinned-only predicates compose without bypassing any filter. Missing
  pins remain inert strings and hidden selections remain exact identities rather
  than silently moving to the next row. Clearing filters can reveal the same row.
- Preference edits and resource filter/order commands preserve the previously
  highlighted unambiguous identity. Matching-row search is explicit navigation,
  does not read a native task or switch to an orchestrator route, and rejects stale
  inventory/filter/preferences and duplicate identities. Header gestures are
  retired on display-scope changes and covered controls do not activate.
- Extend the closed UI-only viewpoint DTO with optional, resource-page-scoped
  preferences: bounded category, inventory/identity order, at most 64 unique bounded
  display pins and a boolean pinned-only flag. Existing saved views need no
  migration. Local bookmarks, Back/Forward and explicit native pin/repin preserve
  preferences without persisting editor bodies, approval, leases or execution state.
- Extend the existing authenticated native viewpoint fixture for malformed/extra
  fields, wrong-page scope, duplicate/oversized/control-bearing identities, schedule
  and environment round trips, stale revision refusal, reopening and unchanged
  native tasks/schedules. No renderer/helper/navigation-matrix tests are added.
- These are functionality and isolation checks, not terminal visual acceptance.
  Original layout, mixed-height reveal and lifecycle parity remain to be completed.

## Integrated retained-history and supplied-source reader batch

- Explicit native history pages now feed a scoped local explorer: supplied-kind
  filtering, searchable loaded-entry selection, 20-entry mounted windows, previous/
  next local navigation and explicit cache clearing. Up to 500 records remain held;
  older paging retains chronological native records and drops newer cached records.
  Hidden/dropped selections never alias another entry. Full records stay available
  in the existing bounded expandable data presentation, without interpreting native
  context/head/fork data or merging it into the live transcript.
- Folding/opening, filtering, searching and local window navigation never call
  `session.history`. Only the explicit newest/older read controls do so. Disconnect,
  disposal and exact source/view changes retire publication. Pending/covered controls
  are guarded; used continuations are withdrawn before dispatch and never retried
  automatically after refusal or an uncertain/lost response.
- Native continuation reservation now happens before the awaited read, preventing
  concurrent reuse of one opaque cursor. Catalog ownership is still checked before
  and after the read; expiry, capacity and session binding remain unchanged. Invalid
  request fields are refused before consuming a cursor. Duplicate native page IDs,
  repeated cursors and conflicting retained identities are not silently adopted.
- Introduce one presentation-only supplied-code reader shared by requested source,
  read/write bodies, shell commands and old/new edit fragments. It mounts at most
  200 newline boundaries / 24,000 UTF-16 units per text window, offers local previous/
  next and searchable range selection, preserves exact substrings and keeps surrogate
  pairs together. Newlines, annotations, explicit empty strings and unavailable
  source distinctions are unchanged. Body positions are not invented file provenance;
  supplied read offsets retain their existing owner-checked numbering.
- Short source preserves its existing code/line-number presentation. Append-only
  updates within the same source/view retain the selected window; replacement,
  phase, path or view changes reset it and retire stale choices. Existing file
  surface hover/colors remain owned by the original card. Unified and multi-file
  diffs remain intact rather than being sliced into synthetic patches.
- A root local-choice context grants only presentation callbacks and input/scope
  guards, not a client or any execution capability. Native and standalone source
  readers share the same existing searchable modal; no implicit filesystem reads,
  native history reads, command submission or approval population are introduced.
- Extend the existing authenticated boundary fixture for concurrent cursor reuse,
  late append isolation, explicit fresh scans, unsupported field refusal without
  cursor consumption and exact multiline/long-line/Unicode/empty source retention.
  These gates establish native boundary behavior, not UI partition/rendering or
  terminal acceptance. No renderer/helper/navigation-matrix tests are added.

## Integrated transcript navigation and reader lifecycle batch

- Mounted thinking/tool cards share explicit scoped selection/toggle/reveal guards.
  A searchable local chooser and documented Ctrl+Alt+G / Left / Right commands
  navigate supplied cards and uniquely linked parents/children. Parent links need
  both supplied task and call pointers; ambiguity, clipping and missing metadata
  never synthesize a hierarchy or adopt another native task. Multiple children use
  the existing local chooser. Added shortcuts appear in help without extending the
  original footer catalog presentation.
- Live slot keys now encode the full session/run/task/entry/call/name/parent tuple
  instead of choosing whichever numeric pointer is present. Repeated exact tuples
  remain nonselectable observations, with distinct display carriers and an explicit
  warning; their ordinal is not a native identity or a fallback navigation target.
  Saved old/unavailable selection strings remain inert rather than being migrated.
- Add a presentation-only native transcript reading context. Supplied text windows
  register independent local rendered anchors and explicit range navigation queues
  an exact key/node reveal after layout. Source replacement changes its local
  anchor generation; append-only updates preserve the existing reader. No renderer
  reference or synthetic source identity is stored in native data or viewpoints.
- Queued reveal captures the exact view, scroll box, session, registry, key and node.
  Oversized targets show their start rather than jumping to an unreadable bottom.
  Reading offsets retain the exact rendered node, not merely a reused logical key;
  byte replacement, unmount and stale registries withdraw old offsets.
- Pointer tool/thinking/prompt folds mark deliberate reading intent without forcing
  a header jump. Source/range and keyboard selection reveal explicitly. Layout
  shrinkage, selection autoscroll or an explicit source reveal reaching the physical
  bottom does not silently resume following. An explicit saved reader mode survives
  Back/Forward restoration; ordinary intentional scrolling and `/latest` retain
  their existing behavior. Reader hold intent is scoped and retired on interruption.
- Header, icon-gutter and independent section gestures retire on source/scope,
  interactivity and disposal changes; section fold state changes retire held taps.
  Native transcript commands are suppressed under help, chooser and busy overlays.
  Timers, row registrations, queued reader/reveal references and caches have bounded
  cleanup. Standalone UUIDs gain no native task or reading-context identity.
- Extend the existing authenticated streaming fixture: detach while work is live,
  verify late durable completion cannot repopulate the detached client, then explicitly
  reobserve the exact session without another faux-model invocation. Full boundary
  gates do not establish rendering, parent-link presentation, viewport geometry or
  visual acceptance; no helper/renderer/navigation-matrix tests are added.

## Integrated local editing and supplied workspace inspection

- Settings JSON, provider intentions and wiki page/comment JSON now share a scoped
  local editor. View/source replacement disposes its old widget while preserving
  the parent-owned draft. Mirroring supplied text is not a user edit; delayed
  callbacks, background editing under a chooser/help/busy overlay and callbacks
  from disposed widgets cannot change drafts or invalidate immutable candidates.
  Structured settings fields retire on document revision replacement and guard
  focus/input/disposal against the same local overlay interactivity.
- Resource action headers retire held gestures on view/overlay changes and guard
  keyboard and pointer activation consistently. None of these local callbacks
  validates a candidate, grants approval, sends a provider request or writes a file.
- Immutable settings/provider/wiki snapshots, wiki page text, provider JSON records
  and receipt result JSON use exact supplied source windows rather than mounting
  arbitrarily tall full bodies. Source replacement also retires range choices;
  native candidate IDs and page revision metadata label source identity only.
  Nonempty provider diffs retain their existing diff presentation; an explicitly
  empty patch is separately described, never replaced with invented patch text.
- Provider cached responses mount at most twenty records. Previous/next and full
  supplied-record search operate only on that retained response; no remote page,
  URL, refresh or approval is requested. Fold keys fingerprint the complete cached
  response plus ordinal and remain presentation-only, not approval/native IDs.
  Response replacement withdraws old picker choices and resets the local range.
- Ctrl+Alt+H and `/input-history` search bounded eligible accepted inputs in this
  exact local view/session. Full text remains searchable behind compact row labels;
  selecting only restores prompt text, with the original eligible draft recoverable
  through forward recall. Admission/eviction, view/session changes or draft edits
  retire a pending choice. Confirmation/mutation and oversized drafts are preserved.
  The submission's original history key is captured before awaited work; a late
  native admission notice is not presented as belonging to a different current view.
- Extend the existing authenticated wiki boundary fixture with a 360-line CRLF,
  supplementary-Unicode and trailing-blank-line document. Exact sealed snapshot,
  applied read and digest remain intact before later revision/approval tests.
  No editor/helper/renderer/snapshot tests or terminal acceptance claims are added.
  Clipboard, notification placement and full original workspace/modal composition
  remain outstanding; this is an integrated functionality/lifecycle increment,
  not a claim of visual parity.

## Notification, diagnostic, selection and exit lifecycle pass

- Port the original right-two/bottom-one corner notification, two-cell horizontal
  padding, semantic tone/icon, bold text and hover/tap presentation locally. Toasts
  expire after three seconds without consuming a permanent notice row. Selection
  drags, inactive-overlay presses and disposed/replaced toast gestures do not
  dismiss a different report; expiry checks the exact mounted report identity.
  The connection warning remains a separate persistent row and is no longer hidden
  indefinitely by an old notice.
- Keep a per-mounted-client diagnostic archive, not a module-global notification
  service: last 32 reports, at most 128000 message UTF-16 units, with each message
  bounded to 64000 units and explicitly marked if truncated at a surrogate-safe
  boundary. Compact toast/choice labels do not replace the retained message.
  Ctrl+Alt+N searches this local archive and opens an immutable read-only report.
  Origins and receive times are local UI metadata, not native receipts, current
  state, provenance, admission or authority. Dismissal preserves the archive;
  terminal cleanup clears it and cancels its timer. No disk persistence is added.
- Retain submitted-command failures in a non-expiring read-only diagnostic dialog,
  using the original error-dialog 70% width / 55% height and header/scroll framing.
  Capture the submit origin before awaiting work. Preserve the existing uncertain
  settings-apply warning and never retry, redeem a confirmation, acknowledge a
  review or decide a native outcome from a displayed error. A later error is
  archived rather than substituted under a reader of the first report. This is
  a client diagnostic viewer, not the native receipt or task-review surface.
- Restore original warning-confirmation chrome for Ctrl+Q terminal exit, with
  explicit local y/n and Escape/backdrop cancellation. Drafts and UI history stay
  intact when cancelling. This dialog has no native command/approval parameters;
  y only invokes the existing renderer quit callback. CLI teardown may close an
  owned host, so neither exit nor continued local display proves completion or
  cancellation. External process signals retain their existing teardown path.
- Fence underlying prompt, workspace, resource, editor and chooser interactions
  while either higher-priority dialog owns the shell. Preserve underlying help
  and local chooser state rather than making their dismissal an implicit action.
  Diagnostic/exit closure is deferred until native keymap dispatch completes and
  checks the exact surviving dialog before mutating local state. The shared modal
  backdrop retires held presses on inactive state and disposal.
- Extend the ordered local Escape path after dialog/help/picker handling:
  breadcrumb focus, editing focus (without discarding the draft), selection,
  current toast, then content focus. Escape never aborts, approves or submits.
  Retire global terminal selection when its view/page/resource or dialog/chooser
  owner changes, without clearing it on unrelated retained transcript updates.
- Restore explicit Ctrl+Shift+C / Meta+C terminal-selection copy with the original
  platform helper order, silent unavailable-helper handling, no shell and bounded
  one-second helper attempts. Only an explicit copy key exports selected text;
  there is no automatic mouse-release export or backend/provider/model request.
  A 256000-byte UTF-8 limit refuses oversized selections without exporting them.
  A zero helper exit means helper acceptance, not verified clipboard contents;
  Linux/Unix terminal OSC 52 fallback is explicitly unverified (including tmux).
  Failed/refused copies retain selection. A destroyed renderer cannot copy.
- Add one authenticated disposable loopback fixture proving client closure leaves
  an accepted in-flight mutation uncertain: it neither revives/replays that client
  nor prevents the owned host from completing the admitted mutation. A separate
  explicitly connected observer reads the result; no faux model invocation occurs.
  This checks the public client/gateway boundary, not terminal exit or rendering.
  No actual clipboard helper/OSC 52, TTY, provider, cluster, deployment, restart or
  credentials are used in verification. Full appearance, platform clipboard
  integration and original automatic selection-copy behavior remain unverified;
  no renderer/helper/snapshot/navigation-matrix tests or parity claims are added.

## Still required before claiming parity

- Remaining workspace resource filters/pin customization, global preference persistence beyond
  explicitly saved viewpoints and the remaining navigation/focus key catalogs.
  Side/mode viewpoint restoration and keyboard breadcrumb focus are restored.
- Remaining original modal components and selection/clipboard interactions;
  the local notification/diagnostic/exit pass does not establish general modal,
  automatic-copy or terminal-placement parity.
- Remaining orchestrator/durable transcript composition: text-line/source-offset
  anchoring beyond the integrated bounded local expansion, native-history merge,
  remaining specialized tool families and
  file/shell header/section composition, remaining timing coverage and
  progress/context arrangement,
  remaining prompt history details, resource/run argument and profile pickers,
  and complete filtering/input behavior. Native model/thinking bundle preparation
  is restored; independent overrides are not offered by the native API.
- Remaining standalone detail/header and focus composition, native-history/source
  anchors and persisted fold state. Scoped inventory/detail reads, rendered-control
  navigation and observed-profile prompt preparation are integrated without
  durable-ID aliases; they do not establish full interaction or visual parity.
- Original settings/provider/wiki/schedules/environment list/detail composition;
  adapt only content and controls incompatible with native authority.
- Interaction/lifecycle audit and terminal visual verification. Compilation,
  functional boundary tests and a successful build do not establish visual parity.

No renderer, snapshot, helper or navigation-matrix tests are introduced. No
credentials, real provider calls, application restarts or deployments are part
of this restoration pass.

## Integrated retained-resource workspace

- Schedule/environment overviews, target definitions, supplied run observations,
  occurrence history, telemetry flat/tree records and diagnostic journals mount
  at most 20 retained records per collection. Local window search retains the
  complete supplied search material; it never requests another native page.
  Ordinals are display carriers, never substitutes for native identity.
- Disclosures reuse bounded supplied-code windows (200 newline boundaries / about
  24000 UTF-16 units). Strings remain exact supplied text, including empty text;
  objects are explicitly serialized supplied JSON fields, not alleged original
  source bytes. Missing, null and empty remain distinguishable. Source replacement
  retires the old code widget/window choices even when its bytes are unchanged.
  Supplied-response fingerprints are UI fold keys only, not approval digests.
- Supplied active/occurrence task and run-owner links navigate catalog observations
  only; missing/ambiguous resource, target, occurrence and run identities disable
  the corresponding controls. No run ID restores readiness, live lease authority
  or permission to stop/restart/recover a resource. Target/profile choices and
  revision-fenced schedule deletion still prepare unsent commands only.
- The environment workbench now shares the scoped local editor: programmatic
  mirroring cannot invalidate an immutable candidate. Its exact unvalidated
  intention and last explicit result use bounded read-only source disclosures;
  manual exact approval, native validation and uncertain-result fences remain.
- Protected HTTP/SQL drafts use the same editor, with a 20000 UTF-16-unit local
  field limit and exact prior-text restoration on refusal. Preparing an unsent
  diagnostic request requires fresh supplied ownership and exactly one writable
  workspace-write task/conversation binding. Actual preparation reports refusal
  instead of claiming a protected existing conversation draft was replaced.
- Telemetry tree indentation is bounded, invalid supplied epochs cannot throw,
  and unusable depth never manufactures parentage. Long summaries label clipping;
  the complete supplied fields remain accessible in local source windows. A
  supplied nextCursor is read-only text for a separately prepared explicit read,
  never automatically followed or persisted in viewpoints/history.

The authenticated faux-loopback boundary fixture retains a 405-line CRLF and
supplementary-Unicode intention beyond source-window bounds, rejects wrong exact
confirmation, refuses an explicitly confirmed but invalid intention and replay,
and proves no native draft was created. The gateway's deliberately masked public
refusal is retained. No renderer, helper, mounting, screenshot or presenter test
is added. Functional gates do not establish visual/interactive parity; no real
environment/provider/model/cluster call, clipboard exercise, restart or deployment
is claimed.

## Integrated task/profile/wiki/skill supplied-data workspaces

- Task catalogs, other pending review observations, detail review cards, owned
  worker records and task evidence descriptors use bounded local record windows
  (at most 20 mounted records per collection). The native 128-worker inspection
  limit remains explicit; local search/paging cannot recover omitted records.
  Worker IDs remain diagnostic only, never app-task/conversation aliases.
- Extract task detail composition into a captured `TaskObservation`: retain its
  top border, review borders, headings, source folds and indentation. Exact
  immutable review text retains diff syntax through bounded source windows.
  Outcomes reuse the original local MarkdownViewer port with bounded rendering
  and an explicit inert-source switch. Window-local markdown can cross a fence
  or structural boundary; no synthetic surrounding source is added.
- Detail controls require a unique selected supplied task owner. Lifecycle and
  review preparation additionally require a fresh connected catalog whose native
  status agrees with the captured detail; reviews match supplied task/revision/
  digest/state and unique identity. Native checks remain final and observations
  are non-atomic. Cancellation/decisions/evidence reads still prepare commands,
  never submit. Related-task and child-transcript links require unique supplied
  catalog pointers; missing/ambiguous identities cannot adopt another worker.
- Profile conversation targets and host definitions have separate bounded local
  searches and source-fenced controls. Target/profile selection is local; current
  model inspection and switching still require separate explicit submission.
  Read-only/terminal, stale, ambiguous, unavailable and unsafe targets/profiles
  cannot generate switch commands. Complete supplied inspection/profile fields
  are bounded read-only observations, not credential or connectivity proof.
- Loaded skill browsing uses local full-descriptor search and bounded exact
  instruction ranges. Supplied id/digest/unique membership and fresh connectivity
  fence read/discussion preparation. Repeated document replacement retires the
  prior instruction widget even when bytes repeat; no disk reload, provider call
  or task admission is performed by selection or range search.
- Wiki page descriptors and retained comment observations are locally paged.
  Long comment text and full supplied records remain available in source windows;
  a comment task link requires the captured page owner and a unique supplied app
  task. Cached documents that do not match the selected supplied page are not
  relabeled. Editor ownership changes with supplied document/selection/mode,
  never with a mirrored keystroke. Sealed candidates retain bounded exact source,
  and stale/replaced/expired candidates cannot prepare save confirmation. The
  placeholder is never an approval; native digest/revision/expiry fences remain.
- Correct the evidence text display gap: decode and retain the WHOLE supplied
  native byte window rather than clipping at 64000 characters and then skipping
  directly to the next native byte window. Local text ranges and separately
  submitted native byte reads are explicitly distinct. Byte metadata/body bounds
  are checked before display/preparation. UTF-8 chunk-boundary replacement glyphs
  are not original file byte/line provenance; binary preview stays signature-only.
  No URL, script, archive, player or arbitrary path is activated.
- Local view-detail JSON also uses bounded supplied-source disclosure. UI source
  fingerprints/ordinals never become native identity, authority or approval.

Authenticated faux-loopback fixtures retain a 405-line supplementary-Unicode/CRLF
loaded skill beyond the local source window, refuse mismatched loaded digests and
show no task admission. The retained report fixture exceeds 64000 text characters
and deliberately splits a four-byte UTF-8 character at the native byte boundary;
its exact byte windows concatenate to the original retained report while separate
decodes explicitly exhibit replacement glyphs. These are public-boundary tests,
not renderer/helper/mounting/presenter acceptance. Biome, full type-check, build,
help and 30 boundary tests (540 assertions) pass. Visual/interactive parity,
clipboard, real integration, Mermaid and deployment remain unverified; no real
provider/model/environment/cluster calls, restart or manual TTY run are claimed.

## Integrated settings/provider/skill-file authoring workspaces

- Settings observations, structured field drafts, advanced JSON drafts and sealed
  candidates are separate disclosures. Profile/provider/repository collections
  use bounded local windows (20 mounted records per collection), including later
  rows. Field ownership follows the exact draft and selected field; a mirrored
  update must not reset the window to zero and transiently unmount its input.
  Non-string supplied fields remain unchanged until an explicit edit. Existing
  opaque disk fields and running profiles/providers/repositories stay preserved;
  saves are restart-required, never live adoption or restart authorization.
- Shared sealed-candidate disclosure retains exact supplied snapshot strings,
  native digests, expiry and metadata. Apply controls require the captured current
  candidate and fresh owner, and prepare only an UNSENT confirmation placeholder.
  They never generate approval, dispatch, follow links or retry a candidate.
- Provider registry and retained response records use bounded local ranges and
  full-descriptor search. Labels are bounded display summaries; complete records
  and complete returned values remain separately inspectable. Catalog membership
  must be unique; retained inspections keep their original provider ownership.
  Native empty patches do not establish upstream absence or lack of changes.
- Correct silent 4096-character clipping of bounded provider JSON GET strings:
  retain the complete token-masked supplied string within the existing HTTP/frame
  budgets. Log/error and write-result caps stay unchanged. This is native masked
  string fidelity, not original upstream byte or pagination provenance.
- Provider receipt identity is provider + requestId, including underscore IDs.
  Journal/source browsing cannot dispatch or replay; receipt preparation requires
  the uniquely matching selected provider. Native destination/results remain
  read-only acknowledgement/uncertainty observations, not completion proof.
  Editor ownership changes on provider/connectivity/freshness transitions, not
  mirrored keystrokes. Local JSON editors restore exact prior drafts on their
  explicit 128000-unit limit; native validation remains final.
- Skill-file authoring preserves the exact 64000-UTF-16-unit draft limit, including
  supplementary Unicode, combining characters and CRLF. An explicit disk read
  cannot overwrite any nonempty draft (including whitespace). Template/discard
  actions are local and explicit. Preview/write match captured name, revision,
  directory, content, expiry and exact manually typed confirmation. Consume the
  local candidate before dispatch. Late acknowledgement stays tied to the old
  attempted request, never populates a newly selected editor or restores replay.
- The full-size fixture exposed a Bun 1.4.4 WebSocket decoder failure: after the
  large valid response, the next small server refusal arrived as an empty message.
  Use pinned npm `ws` through an explicit `ws-client` alias, avoiding Bun's native
  `ws` substitution. Keep loopback Bearer auth, text-only validated envelopes,
  frame/payload budgets and non-replay semantics intact. Transport errors are
  handled without exposing headers/URLs/raw exceptions or retaining freshness.

Authenticated faux-loopback fixtures exercise 27-row settings/provider datasets,
opaque disk-field preservation, complete masked Unicode/CRLF patches, a 23-receipt
journal and matching IDs on different providers. Full-size skill read/preview/write
continues through exact refusal, directory substitution/consumption and hard-link
refusal; invalid length/NUL/unpaired-surrogate drafts refuse. Invalid client auth
has no snapshot or admission. Biome (357 files, zero diagnostics), full unfiltered
type-check, build, help and 34 boundary tests (648 assertions) pass. No renderer,
helper, mounting, presenter or manual TTY acceptance is added. Visual/interactive
parity, clipboard, Mermaid, real integrations and deployment remain unverified;
no real provider/model/cluster/existing-app call, restart or migration is claimed.

## Integrated supplied tool/transcript observation batch

- Bound mounted replacement intents, questions, options, diagnostics and retained
  content/image carriers to 20 per collection. Later records remain locally
  searchable with their original display ordinals; navigation never reads native
  history, resolves recorded browser refs or dispatches work. Keep existing card,
  source/option folds, image previews and shell-output composition. Empty image
  collections add no renderer wrapper. This is not a visual-parity assertion.
- Arguments, details, script output, browser fields and nested completion summaries
  now expose complete supplied data through bounded source windows (200 lines /
  24000 UTF-16 units). The clipped structured explorer is explicitly a summary;
  full supplied fields and text remain accessible separately. JSON serialization
  is not original response/file bytes, and a summary is not linked child history,
  current child status, completion proof or execution/approval permission.
- Retained output browsing preserves each native part independently: no inserted
  separators, discarded non-text metadata or invented structured multipart body.
  The joined main preview and shell tail stay presentation-only; complete part
  fields and exact supplied text are separate. Empty/null/absent content fields
  are disclosed without conflation. Image preview ordinals never become evidence,
  browser, tool, task or conversation targets.
- Dialogue projection retains empty/whitespace strings, including option labels
  and descriptions, rather than converting them into absence or fallback answers.
  Recommendations remain passive stars, not selections. Complete unprojected
  arguments remain available for unsupported/non-string fields. Unpaired results
  and unsupported assistant parts disclose bounded supplied carriers; a serialized
  presentation identity is explicitly not a native target or inferred pairing.
- Capture source ownership independently of selected rows and fold state. Scope
  retained/generated/live cards by the owning supplied message/session, native
  call/result/progress and pairing observation. Replacement withdraws old source
  choices even for repeated bytes. Shared source/record/tree controls honor parent
  interaction/selection fences; readonly tree expansion resets on source-owner
  replacement. No executable handles, native imports, active clarification editor
  or child-relationship reconstruction is introduced.

A new authenticated native faux-loopback fixture retains a long Unicode/combining-
character/CRLF source, 27 replacement/record datasets, empty/opaque nested fields,
27 ordered assistant text parts, unique native call/result links and complete
retained read/patch observations. Reconnect preserves retained entries; an opaque
`approved: true`/task/conversation/approval-shaped record does not grant a child
write or admit another task. Fixture setup uses the public native admission service
and disposable workspace, not storage surgery or injected transport messages.
Biome (359 files, zero diagnostics), full unfiltered type-check, build, help and
35 boundary tests (668 assertions) pass. No renderer/helper/mounting/presenter tests
or manual TTY acceptance are added. Native nested-child transcript composition,
timing/context/Mermaid completion and visual/interactive acceptance remain separate
unfinished work; no real integration, deployment, restart or migration is claimed.

## Integrated native context, reported usage and recorded timing batch

- Add an explicit authenticated `session.context` read through the installed
  native `Conversation.context()` API. Preserve the native applicable head, raw
  active entries, position-aligned contributions after edits/exclusions (including
  empty contributions) and ordered derived model messages. Never substitute the
  retained-history window or rebuild ordering/context in the renderer. Recheck
  catalog ownership after assembly; terminal native children remain readable,
  never writable merely because their context can be inspected. Standalone UUIDs
  and arbitrary/extra selectors do not become durable-session targets.
- Return separately observed configured model/thinking and local catalogue context
  capacity/maximum output. Missing/nonpositive/nonfinite catalogue limits stay
  unavailable. These observations are not atomic, provider-request assembly,
  context occupancy, capacity percentages, current response budgets or approval
  revisions. No provider request, credential/resource discovery, queued-input
  placement, fork, reset, compaction, configuration or adoption accompanies a read.
  The complete serialized projection refuses above 400000 UTF-8 bytes; no silent
  truncation, partial alignment or synthetic continuation is emitted. This bounds
  the reply, not the SDK's internal active-context read.
- Integrate an explicit native context inspector beside retained-history browsing.
  Reads are manual and never polled or replayed. Inspect immutable entry/contribution
  carriers and ordered message records in independent 20-record local windows;
  complete serialized supplied sources retain the existing 200-line / 24000-unit
  source windows. Capture alignment inside the carrier, not a mutable window
  offset. Model/catalogue/head fields stay distinct. Scope/connection replacement
  retires old data and choices, refresh removes the old snapshot before dispatch,
  and late responses cannot adopt another owner. Subsequent commits do not make
  an inspected snapshot current; the inspector explicitly says so.
- Restore the assistant/model footer and original right-edge `Stamp` composition
  with actual supplied request-start timestamps and monotonic recorded response
  durations. Keep recorded zero values and distinguish partial/pending observations
  from retained responses; neither proves task completion. Do not invent completion
  clocks, running timers, thought durations or tokens/second. Exact supplied model,
  response/effort IDs, stop/error/diagnostic fields, usage and timing remain available
  behind scoped bounded metadata disclosure, including empty/absent distinctions.
- Show reported input/output/cache-read/cache-write/cost separately for each
  response and the returned history window. Reasoning and one-hour cache writes
  remain labelled subsets, never added again. Rounded summaries retain separate
  exact source fields; a reported zero is not proof of free billing. Window totals
  remain neither current context size nor lifetime/verified billing totals.
- Replace unbounded inline progress-error/retry/compaction strings with scoped
  supplied-source disclosure. Preserve bounded compaction summaries and failure
  warning, independent 20-record compaction/inbox windows and complete supplied
  run/input records. Retry/deferred clocks are recorded scheduling observations,
  not countdowns, execution, readiness, completion, child navigation or recovery
  controls. Existing parent interaction and captured-choice fences remain in force.

Four additional authenticated faux-loopback boundary fixtures cover 27 active
entry/contribution records, ordered multipart Unicode/combining/CRLF data, exact
zero/empty usage and timing metadata, native omission/replacement edits and reset
heads without history erasure, reconnect equality, whole-projection budget refusal
and next-small-response transport health, completed-child read/write separation,
and 27 native queued follow-ups behind a held generation. Repeated context reads
neither place queued inputs nor create/resume a model request. Setup uses public
native admissions and disposable storage, never storage surgery or injected frames.
Biome (364 files, zero diagnostics), full unfiltered type-check, build, help and
39 boundary tests (729 assertions) pass. No renderer/helper/mounting/presenter tests
or manual TTY acceptance are added. Full original visual/interactive parity,
native nested-child transcript composition, Mermaid and remaining timing/context
presentation still need work; clipboard and real integrations remain unverified.
No deployment, existing-app call, real provider/model/cluster call, restart or
migration is claimed.

## Vendored Mermaid transcript rendering batch

- Vendor the pinned upstream terminal Mermaid renderer (`anomalyco/opencode`,
  `packages/merman/src`, commit `5e066ac…`, MIT, license retained) as source inside
  `src/tui/presentation/mermaid/vendor`. This is a source copy, not a runtime import
  of the previous application: no legacy module, adapter, plugin registration or
  private service is loaded, and no `src/web/*` or embedded-workflow artifact changes.
- Restore the original diagram binding for assistant prose only: the transcript's
  Markdown renderable opts into the fenced-code hook, and the vendored layout reads
  the live theme palette. Every other Markdown surface keeps ordinary fences, and
  transcript data, native authority and retained bytes are untouched.
- Keep the original trust boundary. Diagram layout is synchronous, local and bounded
  (32768 source characters, 500 lines, canvas-size layout); oversize, unparsable,
  unsupported or non-fitting fences stay readable fenced source. Rendering draws
  supplied text only: it never fetches a URL, resolves a `click` target, invokes a
  tool, reads a file or grants approval. A diagram is a presentation of text, not
  evidence, current child status or execution.
- Retain upstream streaming behavior: an incomplete trailing fence keeps its last
  successful diagram for the same block identity, so a diagram does not collapse
  back to raw source on every chunk; the cache is scoped to the claiming renderable
  and retired when it is destroyed. Reachable diagram widths follow the actual
  transcript width rather than a fixed column count.
- Vendored files are excluded from Biome formatting/lint to preserve upstream diffs,
  while remaining inside the unfiltered type-check, the build and the runtime. The
  local adapter is the palette and hook only; no non-null assertion or widened
  authority was added to first-party code.
- Upstream renderable-mounting tests are deliberately not copied. Two local pure
  checks cover family detection across all six supported grammars, ordinary-source
  fallback and bounded parser/layout output for Unicode content in this runtime.

Biome (365 files, zero diagnostics, vendor excluded), full unfiltered type-check,
build, help and 41 boundary tests (747 assertions) pass. No renderer, mounting,
snapshot or presenter test is added, and no terminal visual acceptance is claimed:
diagram legibility, layout at real widths, theme appearance and drag-scrolling still
require manual verification. Native nested-child transcript composition and remaining
timing/context arrangement remain unfinished; clipboard, real integrations,
deployment, restart and migration remain unverified.

## Native tool-field and client-validation batch

- Validate the `session.context` result at the same client boundary as every other native
  result: unpaired entries/contributions, an unreportable model record, a non-string thinking
  value and a projection over the 400,000-character budget are refused whole, never trimmed.
  `head` remains an opaque object or `null`, so no revision can be read out of it.
- Name the supplied fields of the native tool families whose results are structural
  (`request_review`, `attach_image`/`attach_evidence`, `start_task`, `task_result`,
  `cancel_task`, `environment_action`, `env_start`/`env_status`/`env_stop`) in a folded card
  section, clipped at 400 characters with the complete value left under
  Arguments/Details/Output. The section states that supplied fields are not child status,
  completion, approval, adoption or a linked transcript; unrecognized tools keep the generic
  composition, and no field is an affordance.
- Record why nested-call composition stops at live slots: v2 registers no tool that calls
  `executeTool()`, so no nested call is ever created, the retained `NestedCallDoc` family stays
  empty, and it is neither read nor rendered. Live nested slots stay validated (parent task and
  call named) and are composed defensively without inferring a parent from ordering.

Biome (369 files, zero diagnostics), full unfiltered type-check, build, help and 49 boundary
tests (766 assertions) pass, now including client protocol validation. No renderer, mounting,
snapshot or presenter test is added, and no terminal acceptance or visual parity is claimed:
field legibility, fold behavior at real widths and theme appearance still require manual
verification. Remaining unfinished parity: original specialized file/shell header/section
composition for the tool families above, native-history merge, selection/clipboard interactions,
original modal/list compositions, remaining navigation key catalogs and prompt-history details.

## Explicit older-history pages in the reading view

- The reading transcript can now request older native history pages itself. A page is read only
  when the local mounted window is exhausted and the reader asks for more; nothing polls, and no
  page request is issued on mount, on focus or on a live publication.
- A page is an observation above the retained window, never a continuation of it. Its entries keep
  their native identities, are de-duplicated by identity, are ordered by that identity, are capped
  at 400 retained entries, and are shown only above the oldest retained entry. A gap between the
  page and the retained window is explicitly possible and is stated in the view rather than
  papered over.
- The read is fenced the way the standalone history browser already is: the conversation identity,
  history key and connection state are captured before the await, a reply naming another
  conversation is refused, a repeated continuation cursor is refused, duplicate or non-integer
  entry identities refuse the whole page, and conflicting bytes under one identity refuse the page
  instead of replacing it. A failed or uncertain read clears its continuation locally and is never
  retried automatically.
- Pages are local reading state: selecting another conversation, remounting or losing the
  connection clears them. They never replace the live watch, never renumber or reorder native
  entries, never adopt another conversation and confer no authority to resume, approve or answer.

Biome (369 files, zero diagnostics), full unfiltered type-check, build, help and 49 boundary tests
(766 assertions) pass; the history read path itself is exercised by the existing authenticated
gateway fixture (paging, cursor consumption, refusal of foreign cursors and unsupported fields).
No renderer, mounting, snapshot, presenter or helper test is added, and no terminal acceptance or
visual parity is claimed: prelude spacing, markers at real widths, and scroll anchoring across a
merged page still require manual verification. Remaining unfinished parity: original
specialized file/shell header/section composition, selection/clipboard interactions, original
modal/list compositions, remaining navigation key catalogs and prompt-history details.

## Bounded supplied output in the environment detail

- `/logs APP` no longer hands an unchecked value into the detail pane. It requires the
  environments page and an app identity the currently supplied environment observation
  names, and it re-checks the originating view, detail epoch, connection and identity
  after the await before writing the text.
- The client refuses a non-string or oversized `environment.logs` result whole, so the
  pane can only ever display a bounded string. Nothing here polls, retries or infers a
  newer tail: the reader asks again.

Biome (369 files, zero diagnostics), full unfiltered type-check, build, help and 50
boundary tests (771 assertions) pass. No renderer, mounting, snapshot, presenter or helper
test is added, and no terminal acceptance is claimed: the detail pane's appearance at real
widths, and the log tail's colour and fold behaviour, still require manual verification.
Remaining unfinished parity: original specialized file/shell header/section composition,
original modal/list compositions and prompt-history details.
