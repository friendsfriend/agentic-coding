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

## Still required before claiming parity

- Original workspace filter/pin ordering, side/mode persistence and complete
  navigation/focus key catalogs, including keyboard breadcrumb focus.
- Original help/modal components and notification placement.
- Original orchestrator/durable transcript composition, prompt chrome, markdown,
  tool cards, progress and metadata arrangement.
- Original settings/provider/wiki/schedules/environment list/detail composition;
  adapt only content and controls incompatible with native authority.
- Interaction/lifecycle audit and terminal visual verification. Compilation,
  functional boundary tests and a successful build do not establish visual parity.

No renderer, snapshot, helper or navigation-matrix tests are introduced. No
credentials, real provider calls, application restarts or deployments are part
of this restoration pass.
