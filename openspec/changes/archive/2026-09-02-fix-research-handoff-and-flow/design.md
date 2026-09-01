## Context

See proposal.md — Why. The current research→wiki flow splits the handoff across two actors and two commands:

- The researcher records a handoff with `agentic-coding workflow research-handoff` (`agent.research-handoff` command → `recordResearchHandoff` in `runtime.ts`). This only writes the `ResearchHandoff` into `snapshot.step.context.handoff`; it does not transition.
- A **developer** later dispatches `request-research-wiki` (a `developer.action` handled in `runtime.ts`) which re-parses the recorded handoff, runs `validateSourceBaseline`, checks `snapshot.metadata.workspace`, expires the researcher run, and calls `transition(..., "request-wiki", researchContext)` into `core.wiki`.

The `ResearchHandoff` schema (in `definitions.ts`) is `{ subject, canonicalTarget?, findings (freeform string), citations[], noSourcesUsed }`. The `core.wiki` assignment (in `effect-runner.ts`) serializes the whole handoff context as "Research handoff (untrusted evidence)". The wiki agent (`wiki.md`) is told the Step input "carries the researcher's recorded handoff" but has no structured list of concepts to create/update.

Developer answers that shaped this design: (1) fully replace the dashboard trigger with a researcher-initiated handoff; (2) hybrid payload = structured per-concept directives PLUS a freeform narrative field; (3) keep the linear lifecycle (hand off ends research); (4) keep the `core.wiki-approval` gate, only update wiki-agent consumption.

## Goals / Non-Goals

Goals:
- One authenticated researcher-initiated command records the structured handoff and performs the `core.research → core.wiki` transition atomically, preserving the existing safety checks (handoff validity, source-isolation baseline, workspace readiness).
- The handoff payload carries actionable per-concept documentation directives plus a freeform narrative, and the wiki agent consumes the directives as its primary starting point.
- Remove the developer `request-research-wiki` dashboard action and its menu item.

Non-Goals:
- No change to `core.wiki-approval` review UX, `close-research`, `research-follow-up`, standalone-vs-repository start, or the researcher's evidence/tooling behavior.
- No return-to-research path after wiki approval.
- No new external dependency.

## Decisions

### Decision 1: One researcher-initiated command that records and transitions

Repurpose the existing `agent.research-handoff` command path so that, in addition to recording the handoff, it performs the transition into `core.wiki`. The researcher dispatches it via the CLI (the existing `agentic-coding workflow research-handoff` command, extended with the new flags), authenticated as the active `core.research` researcher run.

`recordResearchHandoff` in `runtime.ts` becomes the transition owner: after parsing/validating the enriched handoff, it runs `validateSourceBaseline(snapshot)`, verifies `snapshot.metadata.workspace`, builds the `researchContext` (`{ task, handoff }`), expires the active researcher run(s) and enqueues `agent.stop`, then calls `transition(db, snapshot, definition, "request-wiki", researchContext)` — reusing the exact logic currently in the `request-research-wiki` developer action. On any validation/check failure it throws `WorkflowRuntimeError` with an actionable message and leaves the run active at `core.research` (no expiry, no transition).

- **Why over an alternative**: Keeping a two-step "record then developer-clicks" flow (rejected) is exactly what the developer wants gone. A brand-new command type (rejected) duplicates the authenticated-researcher plumbing that `agent.research-handoff` already has; extending the existing command is smaller and keeps one handoff entry point.
- **Authorization**: The researcher is authenticated as the managed agent for the active `core.research` run (existing `authorizeExactRunCapability` path in `cli.ts`). Because the in-session user is the developer, an explicit user request is the human authorization; the workflow keeps the same source-isolation and workspace gates that previously guarded the developer action, so no safety check is dropped.

### Decision 2: Enriched `ResearchHandoff` schema (hybrid structured + freeform)

Extend `ResearchHandoff` in `definitions.ts` to:

```
{
  subject: string,
  canonicalTarget?: string,
  narrative: string,            // freeform context (renamed/relabeled from findings)
  directives: Array<{
    target: string,             // existing concept id, OR proposed new project-scoped id
    intent: "create" | "update",
    claims: string[],           // specific source-backed facts to document
    citations: string[],        // supporting citations for this directive
  }>,
  citations: string[],          // overall session citations
  noSourcesUsed: boolean,
}
```

- Require at least one `directive`; each directive requires a non-empty `target`, a valid `intent`, and at least one non-empty `claim`. Keep the existing citation rule (at least one overall citation unless `noSourcesUsed`).
- Keep the freeform field so narrative context the structure cannot capture survives. Reuse the existing `findings` field name for this narrative to minimize churn, OR rename to `narrative` — the delta spec is behavior-neutral on the field name; implementation will pick the smaller diff and update instruction text to match.
- Enforce bounded sizes: cap directive count (e.g. reuse the citation-cap pattern), cap per-field text lengths, and keep the existing serialized `MAX_RESEARCH_HANDOFF_BYTES` guard.
- **Why over an alternative**: A pure freeform template (rejected) relies on prose discipline and cannot be validated; a fully structured payload with no narrative (rejected) loses nuance. The hybrid is validatable AND expressive.

### Decision 3: Wiki assignment consumes the directives as primary input

In `effect-runner.ts`, the `researchHandoffInput` block for `isResearchWikiStep` already serializes the handoff context. Update it (and the surrounding `inputs`/`objective` text) to present the directives explicitly as the actionable list of concepts to create/update and the facts to record, while keeping the "untrusted evidence" framing and the corroborate-against-repository-and-wiki instruction. Update `wiki.md` accordingly.

### Decision 4: CLI, command contract, dashboard, and allowed-outcomes updates

- `cli.ts`: extend the `research-handoff` command with flags for directives (e.g. a JSON `--directives` payload) and the narrative field; keep `--subject`, `--target`, `--citations`, `--no-sources`. Update usage/help text.
- `contracts.ts`: the `agent.research-handoff` command already carries `handoff: unknown`; no shape change needed there, but validation continues through `researchHandoffContract.parse`.
- `runtime.ts`: remove the `request-research-wiki` developer action branch and its entry in the exposed `actions()` list. Leave `close-research` and `research-follow-up` intact.
- `data.ts`: remove the "Create wiki draft" (`request-research-wiki`) menu item from the active research phase.
- `assignment.ts`: update the `core.research` handoff-guidance text (the block that tells the researcher to record then wait for the developer) to describe the single researcher-initiated command.
- Instruction assets: rewrite the "Wiki drafting handoff" section of `research.md` and the "Research handoff input" section of `wiki.md`; run `bun run build` to regenerate `embedded.generated.ts` (digests are computed from embedded content by `instructionDigest`, so they update automatically — never hand-edit `embedded.generated.ts`).

### Decision 5: Definitions graph

The research graph already has the `request-wiki` edge `core.research → core.wiki`; the transition reuses it. The researcher run's `allowedOutcomes` (`["blocked","failed"]`, set in `runtime.ts`) stay as-is because the handoff+transition is a dedicated command, not a generic `handoff --outcome`. The `allowedOutcomes` map on the research definition (`["blocked","failed","request-wiki","close-research"]`) — `request-wiki` remains a valid engine transition outcome, now reached by the researcher command rather than the developer action.

## Risks / Trade-offs

- [Researcher self-triggers a state transition previously gated behind an explicit developer action] → Mitigation: the same source-isolation baseline and workspace-readiness checks run inside the command before any expiry/transition; the in-session user request is the human authorization; `close-research` remains developer-only; recording still cannot write to the wiki or mutate the repository.
- [Enriched schema breaks existing recorded handoffs / older callers] → Mitigation: this is an intentional BREAKING change; there is no persisted long-lived handoff format to migrate (handoffs live only in active-run step context), and tests are updated to the new shape.
- [Instruction digest drift if `embedded.generated.ts` is not regenerated] → Mitigation: task explicitly requires `bun run build`; do not hand-edit the generated file.
- [Dashboard menu removal leaves a stale code path] → Mitigation: remove the action from both `data.ts` menu items and `runtime.ts` `actions()`/action-handling, and add/adjust tests asserting the action is no longer offered.

## Migration Plan

No data migration. Deploy the code, instruction, and regenerated-embedded changes together. Rollback is a straight revert of the change set. Any in-flight research workflow simply uses the new researcher-initiated command path after deploy.

## Open Questions

None blocking. Field-name choice (`findings` vs `narrative`) and the exact CLI flag shape for directives are implementation-local and do not affect the specs, approach, or task breakdown.
