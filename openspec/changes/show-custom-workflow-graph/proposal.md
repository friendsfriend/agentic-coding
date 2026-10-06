# Proposal

## Why

A custom workflow looks like any other in the dashboard: the Change panel shows
a definition label, and nothing tells the developer that the graph was composed
for this request, by whom, or why. When they open a review step of such a
workflow they cannot see which stages exist after it. The developer reviews the
work — they should also be able to review the shape.

## What Changes

- The workflow view exposes the definition origin (`built-in` or `custom` with
  its stored origin), the blueprint rationale when present, and the compiled
  logical graph (steps in walk order and their edges, with inserted routing and
  gate steps marked).
- The dashboard Change panel shows `custom · <origin>` next to the definition
  label and the rationale's first line.
- A **workflow graph** dialog (`g` on the Change panel) lists the steps in walk
  order with the current step highlighted and each outcome edge, inserted steps
  dimmed; it is also available for built-in workflows.
- The workspace sidebar marks rows whose definition is custom.

## Capabilities

### New Capabilities

- `custom-workflow-presentation`: how custom definitions, their origin, rationale
  and graph are shown to the developer.

### Modified Capabilities

None.

## Impact

- `src/workflow/runtime/view.ts` (origin, rationale, graph projection),
  `src/contracts/workflow.ts` (view fields).
- `src/tui/dash/panels/ChangePanel.tsx`, a new graph dialog under
  `src/tui/dash/modals/`, `src/tui/dash/keybinds.ts` (Change panel `g`),
  `src/tui/dash/handlers/keys.ts`.
- `src/tui/otel/components/WorkspaceSidebar.tsx`,
  `src/tui/otel/app/sidebar-model.ts`.
- Depends on `persist-custom-workflow-definitions`; shows rationale once
  `add-orchestrator-blueprint-workflows` pins it.
