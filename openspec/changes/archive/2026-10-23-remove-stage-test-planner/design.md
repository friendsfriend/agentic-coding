## Context

`stage-test` is a built-in family that drives one pinned hosted (test) stage. Today it registers
three roles across one graph: `stage-planner` (`stage.plan`, no browser) writes a
`core.stage-test-plan@1` route, an optional `stage.plan-review` developer gate approves it, an
optional `stage.replay` step runs a checked-in compiled flow, `stage-tester` (`stage.execute`,
vision) executes the approved route and returns `core.stage-report@1`, and `stage.review`
approves or asks for a follow-up before the optional `core.wiki` step.

Three mechanisms were bolted onto that shape and each one now costs more than it earns:

1. **Plan-bound execution.** `stage_run` accepted the approved plan object and projected its route
   into block steps; a draft authored during the run was executable only under the route step that
   named it, and its arguments had to come through the `draftArgs` side channel (commit
   `ffce73d`) because the plan could not know a new block's parameters.
2. **Plan-bound approval.** The stage's `planApproval` policy (`always` / `when-writing` /
   `never`) decided whether `stage.plan` stopped at `stage.plan-review`; a plan also had to name a
   block decision per route step (`block`, `blockToCreate`, `blockToAdjust`, `noBlockReason`).
3. **Plan-bound reporting.** The report had to carry exactly one verdict per planned expectation
   and account for every route step in `blocksUsed` or `unblockedSteps`.

The stage's own `access` (`read-only` / `writable`) has been the real write boundary since commit
`81d6ed6` (`src/server/browser/routes.ts` derives `writeAllowed` from it), so the plan never was
the security boundary; it was ceremony on top of one.

Constraint: a registered definition version's digest covers the whole manifest, and a running
workflow dispatches the graph it was pinned to, so the graph cannot be edited in place — it needs a
new version tier. Nothing else may need a migration: stored runs keep working, and no compatibility
shim is added for the removed contracts.

## Goals / Non-Goals

**Goals:**

- One agent (the tester), one step (`stage.execute`), one goal: verify the ticket on the pinned
  test stage by using existing blocks or creating new ones.
- The tester is free to explore: no route to obey, no block decision to justify, no "do not submit"
  that came from an agent that never saw the page.
- The platform's hard rules survive as engine enforcement, not as prose: stage pin, declared
  apps/roles, stage `access` write boundary, no destructive effect, no secret literal, no
  delete/replace of pre-existing records, evidence-backed verdicts, drafts promoted only from a
  proven, claimed report.
- Nothing unreachable is left behind: the plan contract, the plan-bound tool arguments, the replay
  step, the replay eligibility module, the compiled report mapper and their tests go.
- In-flight workflows keep finishing on the definition they were pinned to.

**Non-Goals:**

- No change to how stages are configured, validated or authenticated, beyond dropping
  `planApproval`.
- No change to the stage report's evidence, journal, redaction or promotion machinery.
- No new writer of the wiki: `stage-wiki` stays the only stage-test wiki author, and the tester
  keeps read-only wiki access.
- No change to `STORE_SCHEMA_VERSION`, no migration, no decoder shim for removed metadata fields.
- No new flow authoring surface beyond what `stage_run({ save: true })` already does.

## Decisions

### D1 — One-step graph in a new definition tier

`stageTestManifests(version, authoredBlocks, exploration)` keeps the two historical tiers
(`rounds + 1001` plan-only, `rounds + 1100` authored-blocks promotion) registered, and adds a third
tier `definitionVersionForStageExploration(rounds) = rounds + 1200` whose graph is:

`core.route-stage-execute → stage.execute → stage.review → core.wiki → core.wiki-approval →
core.completed → core.closed`, with `stage.blocks.promote` on both `stage.review` approvals and the
`stage.execute` blocked/failed loops unchanged (3 attempts).

- Why a third tier rather than editing `1001`: a pinned workflow would fail `pin-mismatch` and
  could not resume. Why not reuse `1100`: same reason — its digest is fixed.
- Why keep `1001` at all: it still has to resolve for runs started before this change; the family
  registers all three from one module, and the module's `exploration` flag only changes the step
  list and edges, so the old tiers remain byte-comparable to their stored digests.
- `startup.ts` pins the new tier for new `stage-test` starts.
- Alternative considered: one graph version with an optional `stage.execute`-first route and a
  feature flag read from config — rejected, because "which graph is this run on" must stay a
  property of the pinned definition.

### D2 — `core.route-stage-execute` into the tester

A routing step is kept, mirroring `core.route-plan` / `core.route-apply`: it is the step the
workflow starts in, it selects the model for the tester from the classifier pool and hands over to
`stage.execute`. Keeping a route step (instead of starting at the agent step) preserves the
existing classifier-driven step-model selection for `stage.execute` and leaves the existing
`classification: "single"` declaration in the behavior intact.

- `stage.plan` and `stage.plan-review` step contracts (`definitions/steps.ts`), their behavior
  entries (`steps/stage-test.ts`), their instruction map rows, the `stage-planner` role constant and
  the `STAGE_TEST_PLANNER_ROLE` export are deleted.
- `core.stage-test-plan` (`definitions/contracts.ts`), `StageTestPlanSchema` (`workflow/schema.ts`)
  and every `metadata.stageTestPlan` / `metadata.stagePlanBlocks` / `metadata.stagePlanApproval`
  field and reader are deleted. A pinned older run keeps working because the metadata decoder treats
  those fields as optional and its own step behaviors stay registered; nothing reads them from the
  new graph.

### D3 — The tester's assignment replaces the plan

`stage.execute` keeps `classification: "single"`, `roles/candidateRoles/onArrive` =
`stage-tester`, `instructionAssetForRole` = `stage-test-execute.md`, `acceptsCommentsContext` and the
report render effect. Its `assignmentInputs` no longer print a plan; they carry the pinned stage,
access, ticket and the stage's `wiki.processes` hints, and state the goal (verify the ticket by
using or creating blocks), the freedom (explore, improvise, define the expectations) and the hard
rules (declared apps/roles through stage-bound tools, no credential exposure, no delete/edit of
pre-existing records, no blind retry of a state-changing request, evidence-backed verdicts).

The tester reads process knowledge itself: `stage_info` → `wiki search`/`show` (the existing
read-only stage wiki path in `cli/commands/wiki.ts` already authorises `stage-tester` at
`stage.execute`; only the `stage-planner` branch is removed).

### D4 — `stage_run` takes one plan form

`stage_run({ plan, session, stageApp?, role?, dryRun?, save? })`:

- `plan` must be the standalone `{ planId?, flowId?, inputs?, steps }` document; the
  `core.stage-test-plan` branch (`Array.isArray(raw.route)`), `blockPlanFromRoute`, `draftArgs` and
  `approvedRevision` are removed from the route, the request schema and the agent tool schema.
- A step whose block is one of this run's drafts is allowed: `validateStageBlockPlan` already
  resolves drafts from the run's composed registry, so only the `block-draft-undeclared` refusal and
  its comment go.
- `revision` for a recorded proof is the workflow's current revision (`located.revision`); the
  staleness refusal goes with the plan.
- Kept unchanged: stage-bound session requirement, `stageApp`/role validation, secret-literal
  refusal, destructive-effect refusal, read-only refusal of write blocks, plan-route gap reporting is
  dropped (no route), journal/evidence ingestion, per-draft proof append, compact ledger response.
- `plan-route-gap` issues are removed from the response (they existed only for uncovered route
  steps).

### D5 — Report contract without a plan

`StageTestReportSchema` (`workflow/schema.ts`) becomes:

- `expectations[]`: `{ id, statement, verdict, severity?, expected, observed, stepIds, evidenceIds }`.
  The tester defines them; `statement` is what it verifies.
- `applicationVersions[]`, `createdData[]`, `knowledgeObservations[]`, `notTested[]` unchanged.
- `blocksUsed[]`: `{ block, version }` — no `routeStepId`.
- `blocksCreated[]` / `blocksAdjusted[]`: `{ block, version, digest }` — no `routeStepId`; digest and
  the passed proof of that exact document are still required.
- `unblockedSteps` is removed (it was route accounting); "what was not tested and why" is
  `notTested`.

`contracts.ts`'s `stageTestReport` keeps only the unique-id check. `steps/stage-test.ts`:

- `validReport(report, stage)` (no plan argument): pass/fail need evidence, fail needs severity,
  step ids must be numeric and present in the journal, evidence ids must be attached, application
  versions must cover exactly the declared apps, knowledge observations must be backed by a journal
  entry, and a `blocksUsed` entry must resolve in the registry facts the handoff supplies (replacing
  the plan-resolved version check) — that is what keeps a hallucinated block or version out of the
  report.
- `stageReportBlockIssues` keeps the draft digest + proof rules and loses every route-step
  comparison and the route-coverage loop.
- `stageReportIssues` drops `plan`/`stagePlanBlocks` and keeps the secret scan over the report.

`effect-runner.ts` `stage.report.render`: payload `{ report }`, no plan; the markdown renderer's
`## Plan` section becomes `## Expectations` (statement + priority-free list from the report),
`## Knowledge` reads `knowledgeObservations`, `## Application versions` reads the report, and the
replay line is removed with the replay step. Promotion reads the report's `blocksCreated` /
`blocksAdjusted` claims exactly as today (id, version, digest, proof), so the review approval still
publishes only claimed, proven drafts.

### D6 — Replay becomes a tool, not a workflow step

- Removed: `step("stage.replay", …)`, its graph node and edges, its behavior (including
  `replaySummary`, the `stageReplayEvidence` handling and the "Approve plan and run compiled flow"
  developer action), `runtime/stage-replay-eligibility.ts`, `runtime/stage-replay-evidence.ts`,
  their wiring in `runtime/store.ts`, `runtime/kernel.ts`, `runtime/reducers/agent-handoff.ts`,
  `metadata.stageReplay` / `stageReplayHeal`, `steps/types.ts`'s
  `stageReplayEligible`/`stageReplayEvidence`, `agent-definitions/instructions/stage-test-replay.md`
  and its prompt-inventory row.
- `stage_replay` and `stage_flows` stay as the tester's tools and are allowed during `stage.execute`
  only (the `stage-planner` discovery exemption and the `stage.replay` step exemption are removed
  from `server/browser/routes.ts` and `server/stages/routes.ts`).
- `stage_replay({ flowId, inputs?, dryRun?, session? })` stops requiring an approved plan: the
  approved-plan lookup, `approvedRevision` staleness, `flowId` equality against the plan, the
  route/input projections and the "inputs must equal the approved hash" refusal go.
  `flowEligibility` is split into a manifest-scoped eligibility — spec hash vs manifest, manifest vs
  registry (block versions, digests, documents), stage/app/role declaration, and supplied `inputs`
  against the manifest's own `inputSchema` — which is what protects the stage; the plan-comparison
  half (route hash, input hash, expectation coverage) is deleted with the plan.
- `mapReplayToReport` and `stage-blocks/replay-report.ts` are deleted: nothing maps a replay to a
  `core.stage-report@1` any more. A replay run still ingests its sub-steps into the same stage
  journal (with `source: "replay"`) and evidence store, so the tester's report can cite replay
  journal ids and evidence like any other observation. `stage-blocks/suite.ts` stays: suites are
  independent flow entries and keep running through the same single-flow eligibility.
- Flow authoring stays reachable: `stage_run({ save: true })` on a standalone plan that names a
  `flowId` builds the flow source from the plan's own steps (`flowSourceFromStagePlan` becomes
  `flowSourceFromPlan`: route step id from the step id, application from the block, role from the
  step, captures/expectations empty). Alternative considered: delete flow authoring with the plan —
  rejected, because it would delete `flow-generator.ts` and its coverage while the developer asked
  for the tester to be *more* able to produce reusable building blocks, and because the checked-in
  `stage-flows/` would then have no authoring path at all.

### D7 — The stage's `planApproval` setting is removed

- `server/stages/schema.ts` drops `planApproval` (and `stagePlanApprovalSchema`),
  `stages/catalog.ts` drops it from the view and the `when-writing` default, `contracts/stages.ts`
  drops `StageStatus.planApproval`, `server/stages/routes.ts` stops projecting it, and
  `tui/settings/items.ts` stops printing "plan approval …".
- A stage file that still declares `planApproval` keeps loading: the definition is decoded through
  `Schema.Struct`, whose default excess-property policy ignores unknown keys, so the field becomes
  inert rather than a startup failure. A focused catalog test pins that.
- Alternative considered: keep the field and ignore it at runtime — rejected as a dead option in the
  settings listing; alternative considered: refuse it — rejected as an unannounced breaking change
  for every existing stage file.
- Dashboard: the stage-plan review surface goes (`tui/dash/review.ts`'s `stagePlanContent` /
  `planBlockFacts` / the `stage-test` branch of the plan-review open path, `tui/dash/projections.ts`'s
  `stage.plan-review` action, `tui/dash/App.tsx`'s stage plan-review dispatch) and
  `server/operations/engine.ts` / `server/evidence/routes.ts` / `runtime/view.ts` stop projecting
  `stageTestPlan` / `stagePlanBlocks`. The stage *report* review and the shared openspec plan review
  (`savePlanReview`, the `plan-review` key for other families) are untouched.

### D8 — Instructions and prompt budget

`agent-definitions/instructions/stage-test-execute.md` is rewritten as one short brief: the goal
(verify the ticket by using or creating reusable blocks), how to work (read stage + wiki +
catalog + flows, explore, improvise, `stage_block_save` + `stage_run` to prove a block, list the
blocks worth keeping), the hard rules, and the report shape. `stage-test-plan.md` and
`stage-test-replay.md` are deleted. `prompt-inventory.ts` loses the `stage-planner` family, its role
row and its budget, and the `stage-tester` budget drops from 12.5 KB to ≤ 10 KB (the exact value is
the measured size rounded up, so the budget test keeps failing on deliberate growth). The embedded
assets are regenerated with `bun run scripts/generate-embedded.ts`.

## Risks / Trade-offs

- **A tester that defines its own expectations can define convenient ones** → the report guard still
  requires evidence for every pass/fail, the review is the developer's checkpoint, and the ticket is
  in the assignment so the review can compare. Accepted: this is the point of the change.
- **Removing the plan removes a preview of destructive intent** → the engine never allowed a
  destructive block, and the write boundary is the stage's `access`, unchanged since `81d6ed6`.
  The stage page in the settings catalog still shows `writable` vs `read-only`.
- **Replay without an approved input set can be run with hand-picked values** → eligibility still
  validates the supplied inputs against the flow manifest's own schema, the flow's spec hash and
  every pinned block digest, and the replay only touches the pinned stage under its access policy.
- **A pinned older run whose metadata carries `stageTestPlan`** → the fields stay optional in the
  decoder and its own step behaviors remain registered; the new graph never reads them.
- **Deleting the plan removes compiler-checked usage sites** (`stagePlanBlocks`, `stageReplay`,
  `mapReplayToReport`) → they are enumerated in the tasks; `bun run type-check` plus
  `bun run lint:boundaries` catch a missed reader.
- **The one-step graph loses the plan's "known data creation" signal** → the report's `createdData`
  and the stage's `data.prefix` conventions carry it; nothing in the engine used the plan's
  `createsData` except the removed approval gate.

## Migration Plan

1. Land the new definition tier and start pinning it. Running workflows stay on `1001` / `1100` and
   finish their plan-based graph.
2. Land the tool, schema, server, TUI and instruction changes together; the two old tiers never use
   the removed code paths, so there is no window in which a registered graph references a deleted
   step behavior (the removed steps' behaviors are deleted with their step contracts).
3. Regenerate `src/workflow/embedded.generated.ts`; the developer rebuilds and restarts.
4. Rollback: revert the commit; stored runs pinned to `1200` would then fail to resolve, so a
   rollback is only safe before any new `stage-test` start.

## Open Questions

- Should the report keep a `priority` per expectation (the plan's priority fed the replay severity
  mapping, which is going away)? The design drops it; the review can still read statements.
- Should `stage_run({ save: true })` flow authoring be kept at all (D6)? The design keeps it; the
  plan review can delete it and with it `flow-generator.ts` usage from the server.
