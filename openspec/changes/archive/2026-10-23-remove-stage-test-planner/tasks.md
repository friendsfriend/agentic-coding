## Implementation notes

The developer explicitly requires already-running workflows to retain their
pinned definition. The historical-deletion tasks below are therefore completed with explicit
new-workflow scoping rather than destructive removal: 1.3, 1.5, 2.1, 2.3, 3.3, 4.1, 4.2 and 5.4 retain the
historical contracts, roles, metadata readers, behaviors, tool-step allowances
and dashboard actions needed to compile and execute pinned older tiers. None
is reachable from the new exploration graph. Task 2.1's plan-free report schema
and validation are implemented, while its historical decoders remain. Task
6.1's tester rewrite is implemented (measured complete assignment: 10,095 B
against 10,240 B); historical planner/replay assets remain for pinned steps.
Task 7.1's exploration/report/graph tests are implemented alongside, rather
than instead of, historical plan/replay/digest coverage. No migration, new
compatibility tier or store schema version change was added.

Verification: OpenSpec strict validation; final `bun run type-check` and
`bun run build`; `bun run lint` (including 71 boundary tests); a 244-test focused
stage/workflow/tool regression batch; and 110 focused settings/dashboard/
pinned-workflow tests all passed. Earlier block/data/flow/CLI tests had four
known generated-spec install failures from Artifactory HTTP 401 in
`stage-data-block.test.ts`; these are the developer-permitted environmental
exclusion, not hidden passing tests. No full-suite run was performed.

Deployment: the build regenerated embedded assets. After merge, the developer
must rebuild and restart; running workflows must not be re-pinned.

## 1. Definition and graph

- [x] 1.1 Add `definitionVersionForStageExploration(rounds) = rounds + 1200` to
      `src/workflow/definitions/manifest-policy.ts` and register it in
      `src/workflow/definitions/registerBuiltins.ts` beside the existing `+1001` and `+1100` tiers.
- [x] 1.2 Teach `src/workflow/definitions/graphs/stage-test.ts` a third variant
      (`stageTestManifests(version, authoredBlocks, exploration)`): the exploration graph is
      `core.route-stage-execute → stage.execute → stage.review → core.wiki → core.wiki-approval →
      core.completed → core.closed`, with the promotion node on both review approvals and the
      `stage.execute` blocked/failed retry edges. The two historical variants must stay
      byte-identical to their stored digests.
- [x] 1.3 Exclude `stage.plan`, `stage.plan-review` and `core.stage-test-plan` from the
      exploration graph and register `core.route-stage-execute` as its initial step. Retain the
      historical contracts/instruction mappings so pinned older workflows still compile.
- [x] 1.4 Pin new `stage-test` starts to the exploration tier in `src/workflow/startup.ts`.
- [x] 1.5 Use only execute/review behaviors in the exploration graph; retain
      `STAGE_TEST_PLANNER_ROLE`, plan behaviors and their helpers for pinned older definitions.
- [x] 1.6 Update `src/workflow/definitions/catalog.ts`'s `stage-test` entry so its description names
      the one-step graph and its roles are `stage-tester`/`stage-wiki` only.

## 2. Schema and contracts

- [x] 2.1 Retain `StageTestPlanSchema` and `stageReplayHeal` only for historical readers; rewrite
      `StageTestReportSchema` per the design (tester-defined `expectations`, no `unblockedSteps`, no
      `routeStepId`, `blocksUsed` as `{block, version}`, `blocksCreated`/`blocksAdjusted` with
      `digest`).
- [x] 2.2 Drop the `plan` argument from the report validation in
      `src/workflow/definitions/contracts.ts` and `src/workflow/steps/stage-test.ts`; replace the
      plan-resolved block check with a registry-facts check (`blocksUsed` must resolve at that
      version) and keep the created/adjusted digest + proof rules.
- [x] 2.3 New starts do not create stage plan/approval metadata. Retain historical
      metadata/view fields and their projections in contracts, runtime, server and evidence
      readers so pinned workflows remain readable without a store migration.
- [x] 2.4 In `src/contracts/stage-blocks.ts` remove `draftArgs` and `approvedRevision` from
      `StageRunRequest`; delete `src/contracts/stage-replay.ts`'s approved-plan fields if any remain
      unused.

## 3. stage_run and stage_block_save

- [x] 3.1 In `src/server/browser/routes.ts` delete the `core.stage-test-plan` branch of
      `stage_run` (`Array.isArray(raw.route)`, `blockPlanFromRoute`, the `draftArgs` mapping, the
      `standalone plan must not reach into this run's drafts` refusal, the `approvedRevision`
      staleness refusal and the `plan-route-gap` issues); `revision` for a recorded proof comes from
      the workflow record.
- [x] 3.2 Keep and test the surviving refusals: stage-bound session requirement,
      `stageApp`/role validation, secret literal, destructive block, read-only write block, unknown
      block, own-draft resolution, per-draft proof append.
- [x] 3.3 The exploration graph exposes stage tools during its sole tester step,
      `stage.execute`. Retain historical plan/replay tool-step allowances for pinned workflows;
      no such steps are reachable in the exploration graph.
- [x] 3.4 Delete `assertStageTestRoute` and the plan-based `assertStageTestTarget` checks; keep the
      pinned-stage, declared app/role and method-allowlist refusals.

## 4. Replay decoupling

- [x] 4.1 Omit `stage.replay` from the exploration graph and delete
      `stage-blocks/replay-report.ts`/`mapReplayToReport`. Retain historical replay contracts,
      behaviors, developer actions, instruction assets and runtime readers for pinned workflows.
- [x] 4.2 Exploration execution and report rendering do not consume replay eligibility,
      replay evidence or heal metadata. Retain those fields and runtime facts for pinned
      historical replay; a replay without a usable report falls back to its tester step.
- [x] 4.3 Rewrite `stageReplay` in `src/server/browser/routes.ts` to drop the approved-plan lookup,
      `stage-plan-missing`/`stage-plan-stale`, the plan `flowId` equality, the route/input
      projections and `flow-inputs-unapproved`; keep manifest eligibility, dry run, single-flow and
      suite execution, the heal packet in the answer and journal/evidence ingestion.
- [x] 4.4 Reduce `flowEligibility` in `src/stage-blocks/flow-registry.ts` to the manifest-scoped
      checks (spec hash, registry versions/digests, pinned data documents, stage/app/role
      declaration, supplied inputs vs manifest `inputSchema`) and delete the route-hash,
      approved-input-hash, route-step-projection and expectation-coverage refusals.
- [x] 4.5 Make flow authoring reachable from a standalone plan: replace `flowSourceFromStagePlan`
      with a plan-only `flowSourceFromPlan` in `src/stage-blocks/flow-source.ts` (step id from
      `step.id`, application from the block, role from the step, empty expectation mapping) and keep
      `stage_run({ save: true })` working with a plan that names a `flowId`.

## 5. Stage configuration, report render and TUI

- [x] 5.1 Remove `planApproval` from `src/server/stages/schema.ts`, `catalog.ts` (view + the
      `when-writing` default), `src/server/stages/routes.ts` and `src/contracts/stages.ts`; keep the
      agent-preset gate `planApproval` untouched. Add a catalog test proving a stage file that still
      declares `planApproval` loads and the value has no effect.
- [x] 5.2 Stop printing the plan approval in `src/tui/settings/items.ts`.
- [x] 5.3 Update the `stage.report.render` payload and `stageReportMarkdown` in
      `src/workflow/effect-runner.ts` to render expectations, knowledge observations and application
      versions from the report itself and to drop the plan and replay sections; keep the block
      section and its bounds and the shared redactor.
- [x] 5.4 New exploration workflows never enter a plan-review surface. Retain the
      dashboard's historical stage plan review/actions for pinned workflows and leave other
      families' plan reviews unchanged.
- [x] 5.5 Keep draft promotion driven by the report's `blocksCreated`/`blocksAdjusted` claims in
      `src/workflow/effect-runner.ts` and adjust the review approval label if it referenced the
      plan.

## 6. Instructions and prompt inventory

- [x] 6.1 Rewrite `agent-definitions/instructions/stage-test-execute.md` as one short brief: the
      goal, how to work (stage + wiki + catalog + flows, explore, `stage_block_save` + `stage_run`,
      improvise), the hard rules (pinned stage, declared apps/roles, no secrets, no delete or edit of
      pre-existing records, read-only vs writable, evidence-backed verdicts) and the report shape.
      Retain `stage-test-plan.md` solely for the pinned historical planner contract.
- [x] 6.2 Remove the `stage-planner` family, its `PROMPT_ROLES` row and its budget from
      `src/workflow/prompt-inventory.ts`; lower the `stage-tester` budget to the measured size
      (≤ 10 KB).
- [x] 6.3 Regenerate `src/workflow/embedded.generated.ts` with
      `bun run scripts/generate-embedded.ts` and confirm `src/workflow/wiki.ts`'s stage role list no
      longer names `stage-planner`.

## 7. Tests

- [x] 7.1 Extend `test/stage-test-workflow.test.ts`, retaining historical plan/replay and
      digest coverage for pinned workflows; assert
      the three registered tiers resolve and that the exploration tier's graph, roles and initial step
      are the one-step shape, and cover the new report guard (evidence, application versions,
      knowledge backing, block resolution, created-block digest + proof).
- [x] 7.2 Update `test/stage-block-routes.test.ts`, `test/stage-flow.test.ts`,
      `test/stage-replay-process.test.ts` and `test/stage-data-block.test.ts` for the single plan
      form and the plan-free replay path; retain and update the historical
      `test/workflow-stage-replay-eligibility.test.ts` coverage.
- [x] 7.3 Update `test/workflow-startup.test.ts`, `test/workflow-registry.test.ts`,
      `test/settings-stages.test.ts`, `test/settings-configuration.test.ts`,
      `test/dash/stageTestLaunch.test.tsx` and `test/server/blueprintStart.test.ts` for the new tier,
      the retired stage `planApproval` field and the exploration graph's lack of plan review.
- [x] 7.4 Update the prompt tests for the removed planner family and the new tester budget.
- [x] 7.5 Add a test that a workflow started on the older tier still resolves its plan steps, and a
      test that `stage_replay` runs a checked-in flow with tester-supplied inputs without an approved
      plan.

## 8. Docs and checks

- [x] 8.1 Update `agentic-coding/docs/workflow-architecture.md` (stage-test tier table, step list,
      replay eligibility section), `docs/stage-flow-replay.md`, `docs/stage-blocks.md`,
      `docs/config-inventory.md` and `docs/settings-inventory.md` for the removed planner,
      `planApproval` and replay step.
- [x] 8.2 Run `bunx openspec validate "remove-stage-test-planner" --strict`, then from
      `agentic-coding/`: `bun run type-check`, `bun run lint` and `bun run stage-flows:check`.
- [x] 8.3 Run the focused suites with a temporary HOME (never the real store):
      `HOME=$(mktemp -d) bun test test/stage-test-workflow.test.ts test/stage-block-routes.test.ts
      test/stage-flow.test.ts test/workflow-startup.test.ts test/settings-stages.test.ts`.
      Ignore the known 401 artifactory install failures in `test/stage-data-block.test.ts`'s saved-flow
      cases.
- [x] 8.4 Report the developer action needed after merge: rebuild and restart
      (`bun run scripts/generate-embedded.ts`, then the normal build/restart), and note that running
      stage-test workflows keep their pinned definition.
