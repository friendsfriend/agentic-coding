# Design

## Context

`WorkflowView.definition` carries the pin plus label. The resolver from
`persist-custom-workflow-definitions` knows whether a definition is built-in or
stored and has the stored origin. Dashboard panels publish keybinds with a panel
`context`; dialogs are dashboard modal stack entries.

## Goals / Non-Goals

**Goals:**

- Origin and rationale visible without opening anything.
- The graph readable in a terminal without a graph layout engine.

**Non-Goals:**

- Editing a workflow's graph.
- A drawn node-link diagram.

## Decisions

- **Projection in the view, not the TUI.** `view.ts` returns
  `definitionGraph: { steps: [{ id, label, actor, inserted }], edges: [{ from,
  outcome, to, loop? }] }` in walk order (BFS from the initial step, stable by
  edge order). The dashboard stays an action/presentation client and never reads
  the registry.
- **Inserted steps marked.** Routing, triage-routing and gate steps carry
  `inserted: true` so the dialog can dim them; the developer reads the logical
  graph first.
- **`g` on the Change panel.** Panel-scoped keybind with `context` so the
  footer shows it only there; the `?` help lists it. Built-in workflows get the
  same dialog, so the keybind is never a dead key.
- **Sidebar mark is a glyph, not text,** to keep rows within width.

## Risks / Trade-offs

- [Large graphs overflow the dialog] → The dialog scrolls (j/k) like other
  dashboard dialogs.
