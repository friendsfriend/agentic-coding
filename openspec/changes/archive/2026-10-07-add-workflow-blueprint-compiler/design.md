# Design

## Context

Built-in graphs are built by family modules and then transformed:
`commonImplementationSteps(triageRoute)` threads `core.triage-route` between
implementation and triage, gate steps are inserted at the stage-gate tier, and
`withPerStepRouting` adds a `core.route-*` step before every classifiable step.
All of these are pure functions in `definitions/`, in the domain layer the
blueprint compiler also lives in.

## Goals / Non-Goals

**Goals:**

- A blueprint a model can write reliably (no internal steps, no step versions).
- A compiled manifest indistinguishable in shape from a built-in of the newest
  tier.
- Human reviews are a structural invariant of every compiled blueprint.

**Non-Goals:**

- Step parameters (verifier role subsets, per-step instructions, custom
  prompts). Open question for a later change.
- New step kinds; documentation targets (wiki, research).
- Storage, server routes or tools (separate changes).

## Decisions

- **Logical steps only.** A blueprint may use `core.plan`, `fusion.plan`,
  `fusion.consolidate`, `core.plan-approval`, `core.implementation`,
  `core.triage`, `core.verification`, `core.developer-review`,
  `core.findings-review`, `core.wiki`, `core.wiki-approval`, `core.archive`,
  `core.delivery`, `core.rebase`, `core.completed`, `core.closed`. Any
  `core.route-*`, `core.triage-route` or gate step is rejected with a pointer that
  the compiler adds it.
- **Insertion order mirrors the built-ins:** triage routing before
  `core.triage`; plan gate between planning and plan approval; review gate
  between a passing verification and developer review; wiki gate before
  `core.wiki`; then per-step routing. The compiler reuses the built-in transform
  functions instead of reimplementing them, so a built-in family expressed as a
  blueprint compiles to the same graph shape (tested for the nine repository
  code-change families: `openspec`, `openspec-apply`, `openspec-propose`,
  `openspec-fusion`, `openspec-fusion-propose`, `no-openspec`, `solo`, `rebase`
  and `verify`).
- **Review invariant on the logical graph, by removal.** For each rule, delete
  the review node(s) and check reachability: e.g. with `core.developer-review`
  and `core.findings-review` removed, no path from the graph's **entry step**
  may reach `core.delivery`, `core.archive` or `core.wiki`. Anchoring on the
  entry (not on `core.implementation`) also rejects an author-controlled entry
  that starts the run after the review chain, and the rule runs for every graph
  (an implementation-free plan/verification/rebase graph that hands straight off
  to a delivery step is rejected too); the entry step itself is never a
  forbidden target, so the wiki-only shape — whose entry is the gated
  `core.wiki` — stays legal (the wiki-approval rule guards it). The derived entry
  is further constrained to a step a run may begin with. `core.completed` counts
  as a delivery point for a workflow that pushes code: it contains
  `core.delivery` or `core.archive`, or its delivery trait is `pull-request`
  while its `core.completed` offers `create-pr` (the trait is what
  `steps/lifecycle.ts` reads before offering the action, so a `delivery: none`
  `create-pr` edge is inert). The solo shape, whose only exit is completion and
  which pushes nothing, is exempt (the recorded resolution of the conflict with
  the solo-equivalence clause). Planning reaching implementation, delivery,
  archive or completion only through `core.plan-approval` is the second rule;
  this handles loops without path enumeration and runs before gate insertion
  (the orchestrator pins those gates to `always`).
- **Traits drive policy.** The blueprint's traits become the manifest policy
  (`targetKind: repository`, `checkoutRequired` from the blueprint's own
  `checkoutRequired` flag, default `false`), the traits' structural validation
  from the registry applies, the change identity must agree with the graph's
  planner (`planned` exactly when a planner is present), and `clean-tree` is
  added to the start requirements whenever the graph delivers or archives. A
  `core.verification` graph must carry a `fix` loop bound equal to the declared
  `verificationRounds`.
- **Diagnostics, not exceptions.** `compileBlueprint` returns
  `{ ok: true, manifest, digest, summary } | { ok: false, diagnostics }`, each
  diagnostic naming the step/edge and the rule, so a model can fix its blueprint.

## Risks / Trade-offs

- [Built-in transforms assume family shapes] → The equivalence tests for the
  nine repository code-change families catch drift; transforms that need family
  knowledge read traits.
- [A blueprint that is valid but pointless (e.g. review with nothing to review)]
  → Allowed; the rationale is shown to the developer, who reviews it anyway.
