## Why

The stage-test family splits one job across two agents: `stage-planner` writes a route for a UI it
has never seen — it has no browser, so its route is speculation — and `stage-tester` then explores
that UI anyway. The approved plan has turned into a rigidity the developer did not want: a run
stopped because the plan said "do not submit" (workflow run `-8`), a draft block could not be run
because `stage_run` took arguments only from the approved plan (run `-10`, patched with a
`draftArgs` side channel in commit `ffce73d`), and the report had to account for every planned
route step. What the developer wants from a stage test is one thing: verify the ticket on a test
stage, using existing blocks or creating new ones, with the stage's access setting as the only
write boundary.

## What Changes

- **BREAKING** The `stage-test` definition becomes
  `core.route-stage-execute → stage.execute → stage.review → core.wiki → core.wiki-approval →
  core.completed → core.closed`. `stage.plan`, `stage.plan-review`, the `stage-planner` role, its
  instruction asset `stage-test-plan.md`, the `core.stage-test-plan@1` contract and the
  `stagePlanApproval` gating are removed. A new definition version tier (`rounds + 1200`) carries
  the new graph so in-flight workflows keep the definition they were pinned to.
- The `stage-tester` becomes the workflow's only agent. It starts from the ticket and the stage
  description, reads the stage catalog, the read-only wiki, the block catalog and the saved flows,
  explores with the browser, and decides itself which expectations to verify. It still never
  writes the wiki.
- `stage_run` accepts only a standalone block plan `{ planId?, flowId?, inputs?, steps }` whose
  per-step `args` the tester composes, and may run this run's own drafts. `draftArgs`, the
  approved-plan-object form and the `approvedRevision` staleness check are removed. The stage-bound
  session requirement, secret-literal refusal, destructive-effect refusal, read-only refusal of
  write blocks, journal/evidence ingestion and the per-run proof recorded on a draft are kept.
- `core.stage-report@1` drops the plan: expectations are the tester's own (id, statement, verdict,
  expected, observed, journal step ids, evidence ids), `blocksUsed`/`blocksCreated`/`blocksAdjusted`
  lose their route-step accounting (created/adjusted keep digest + proof), `unblockedSteps` is
  replaced by the free-form `notTested`, and `applicationVersions`, `createdData` and
  `knowledgeObservations` stay. The report guard no longer requires route coverage.
- **BREAKING** The stage definition no longer takes a `planApproval` policy: the catalog view, the
  settings listing, the launch surfaces and the dash projections stop carrying it, and the stage's
  `access` (`read-only` / `writable`) is the only write boundary.
- The plan-gate replay route disappears: `stage.replay`, `core.route-stage-*`'s replay offer,
  `runtime/stage-replay-eligibility.ts` and the compiled report mapping go, and `stage_replay`
  becomes a plain tool the tester may call during `stage.execute` when a checked-in flow covers the
  ticket, with eligibility checked against the flow manifest instead of an approved plan.
- `stage-test-execute.md` is rewritten as one short, non-restrictive brief; the prompt inventory and
  its budget lose the `stage-planner` family and keep a lower tester budget.
- Specs, docs and tests are updated; the plan-specific tests are removed or re-pointed at the
  one-step flow.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `stage-test-workflow`: the family's steps and roles, the removed plan gate and plan-review
  surface, the tester's brief and assignment, and the plan-free report contract.
- `stage-block-plans`: the accepted plan form, draft executability, plan-bound validation and the
  "approval is preserved" requirement.
- `stage-flow-replay`: replay eligibility without an approved plan, the removed deterministic report
  mapping, and the tool-based replay path.
- `stage-data-blocks`: `stage_block_save`/write-block gating on stage access instead of an approved
  plan's declared data creation.
- `stage-process-knowledge`: the tester, not the planner, resolves process knowledge before testing.
- `knowledge-wiki`: `stage-planner` leaves the wiki role lists; the tester and `stage-wiki` remain.

## Impact

- Workflow definition: `src/workflow/definitions/graphs/stage-test.ts`,
  `definitions/steps.ts`, `definitions/contracts.ts`, `definitions/manifest-policy.ts`,
  `definitions/registerBuiltins.ts`, `src/workflow/startup.ts`, `src/workflow/embedded.generated.ts`
  (regenerated), `src/workflow/prompt-inventory.ts`, `src/workflow/schema.ts`.
- Steps and runtime: `src/workflow/steps/stage-test.ts`, `steps/types.ts`, `steps/gates.ts` if it
  references the stage plan, `runtime/store.ts`, `runtime/view.ts`, `runtime/kernel.ts`,
  `runtime/reducers/agent-handoff.ts`, `runtime/stage-replay-eligibility.ts` (removed),
  `runtime/stage-replay-evidence.ts` (removed), `effect-runner.ts` (report render + promotion),
  `src/contracts/workflow.ts`.
- Tools and server: `src/contracts/stage-blocks.ts`, `src/contracts/stage-replay.ts`,
  `src/contracts/stages.ts`, `src/agent-host/browser-tools.ts`, `src/server/browser/routes.ts`,
  `src/server/stages/{schema,catalog,routes}.ts`, `src/server/operations/{engine,observations}.ts`,
  `src/server/evidence/routes.ts`, `src/stage-blocks/{flow-registry,flow-source,suite}.ts`,
  `src/stage-blocks/replay-report.ts` (removed).
- TUI: `src/tui/dash/review.ts`, `src/tui/dash/projections.ts`, `src/tui/dash/App.tsx` (stage plan
  review dispatch), `src/tui/settings/items.ts`.
- Instructions: `agent-definitions/instructions/stage-test-execute.md` (rewritten),
  `stage-test-plan.md` and `stage-test-replay.md` (deleted).
- Docs: `agentic-coding/docs/workflow-architecture.md`, `docs/stage-flow-replay.md`,
  `docs/stage-blocks.md`, `docs/config-inventory.md`, `docs/settings-inventory.md`.
- Tests: `test/stage-test-workflow.test.ts`, `test/stage-block-routes.test.ts`,
  `test/workflow-stage-replay-eligibility.test.ts` (removed), `test/stage-flow.test.ts`,
  `test/workflow-startup.test.ts`, `test/workflow-registry.test.ts`,
  `test/workflow-prompt-budget.test.ts`, `test/workflow-prompt-sections.test.ts`,
  `test/settings-stages.test.ts`, `test/settings-configuration.test.ts`,
  `test/dash/stageTestLaunch.test.tsx`, `test/server/blueprintStart.test.ts`.
