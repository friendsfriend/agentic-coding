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

## Still required before claiming parity

- Original workspace filter/pin ordering, side/mode persistence and complete
  navigation/focus key catalogs. Keyboard breadcrumb focus is already restored.
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
