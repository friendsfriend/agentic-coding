## Why

The research→wiki flow does not work well in practice. The wiki agent receives only a single freeform `findings` string, so it does not know which concepts to create or update or exactly what to document. The handoff is also split awkwardly across two actors: the researcher merely *records* a handoff, and a separate developer dashboard action (`request-research-wiki`) actually starts wiki drafting. Since the person conversing with the researcher in the persistent session is the developer, an explicit in-session user request should itself drive the handoff — going back to the dashboard to click a button is redundant and disconnected from the request that motivated it.

## What Changes

- **BREAKING**: Remove the developer dashboard `request-research-wiki` action as the trigger for wiki drafting. The only path into `core.wiki` becomes a researcher-initiated handoff, dispatched by the researcher acting on an explicit in-session user request.
- Add a single researcher-initiated command that both records the structured handoff payload and transitions `core.research → core.wiki` in one authenticated step (still gated by the same source-isolation validation and workspace-readiness checks the developer action performed).
- Enrich the handoff payload the wiki agent consumes: keep the existing `subject`, optional `canonicalTarget`, `citations`, `noSourcesUsed`, and a freeform narrative field, and add a structured list of per-concept documentation directives. Each directive names a target concept (an existing concept id to update, or `new` with a proposed project-scoped id), a create-or-update intent, the specific source-backed claims/facts to document, and supporting citations.
- Update the researcher instructions (`research.md`) so the researcher gathers the structured directives during research and dispatches the combined record-and-transition command on explicit user request, instead of recording a handoff and telling the developer to use the dashboard.
- Update the wiki agent instructions (`wiki.md`) and the effect-runner assignment input so the wiki agent consumes the structured directives as its primary, actionable starting point (which concepts to create/update and exactly what facts to record), while still corroborating against repository evidence and the centralized wiki before writing.
- Preserve the linear lifecycle (`core.research → core.wiki → core.wiki-approval → core.closed`) and the developer `core.wiki-approval` gate unchanged; handing off still stops the research session with no return to research, and `close-research` remains the developer-only closure action at any active step.

## Capabilities

### New Capabilities
<!-- None. This change modifies the existing research-workflow behavior. -->

### Modified Capabilities
- `research-workflow`: The handoff-and-transition requirement changes so the researcher (not the developer) initiates the wiki transition on explicit user request; the recorded handoff gains structured per-concept documentation directives plus a freeform narrative field; and the wiki stage receives those directives as its primary actionable input. The closure requirement is updated to drop `request-research-wiki` from the set of developer actions available during research.

## Impact

- Workflow definitions (`src/workflow/definitions.ts`): `ResearchHandoff` contract/schema and research graph allowed outcomes/edges.
- Runtime (`src/workflow/runtime.ts`): remove/repurpose the `request-research-wiki` developer action; add the researcher-initiated record-and-transition handling with source-isolation and workspace checks; adjust the researcher run's allowed outcomes; adjust exposed developer actions.
- CLI (`src/workflow/cli.ts`) and command contracts (`src/workflow/contracts.ts`): the researcher handoff command that performs the transition.
- Effect-runner (`src/workflow/effect-runner.ts`): assignment input mapping for the enriched handoff into the `core.wiki` run, and researcher assignment/permissions text.
- Dashboard (`src/tui/dash/data.ts`): remove the "Create wiki draft" developer menu item from the active research phase.
- Instruction assets (`agent-definitions/instructions/research.md`, `agent-definitions/instructions/wiki.md`) and their pinned digests; `src/workflow/assignment.ts` handoff guidance text.
- Tests covering the research handoff, the wiki transition, and the enriched payload.
