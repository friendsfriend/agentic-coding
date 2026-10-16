# Tasks

## 1. Classifiable metadata from step behavior

- [x] 1.1 Declare `classification: "single"` on `core.research` and audit every other agent step behavior (`core.plan`, `fusion.plan` roster, `fusion.consolidate`, `core.implementation`, `core.triage`, `core.verification`, `core.wiki`, `core.archive`) so each declares its mode. Verify with a focused step test asserting every role-bearing step declares a mode and no non-agent step does.
- [x] 1.2 Replace the `POOL_STEPS` table with a lookup derived from the registered step behaviors, keep the config-facing key set identical for existing steps, and add `core.research`. Verify with a focused test asserting the derived set equals the behaviors' declarations and that a step without a mode is not classifiable.

## 2. Route steps

- [x] 2.1 Add `routingBehaviorStep(targetStepId)` and register one route step per classifiable step (`core.route-plan`, `core.route-implementation`, `core.route-triage`, `core.route-verification`, `core.route-wiki`, `core.route-archive`, `core.route-research`, `core.route-fusion-plan`, `core.route-fusion-consolidate`), each a system step with the `complete` outcome, `allowedEffects: ["model.classify"]`, and a retry limit. Verify with a focused test that each route step enqueues exactly one routing effect naming its target step.
- [x] 2.2 Emit one routing question per request from the effect payload's `stepId` (pool entries from the effective preset, mode from the step behavior) and drop the `PLAN_PHASE_STEPS`/`APPLY_PHASE_STEPS` question assembly. Verify with a focused classifier test that the request carries exactly that step's question and that a `roster` step still asks its roster question.
- [x] 2.3 Assemble the state per step: task only before a plan step; task + planning artifacts + changed-file paths afterwards, never diff bodies. Verify with a focused test for both shapes and for a bounded size.

## 3. Definition graphs

- [x] 3.1 Insert the route step before every classifiable agent step in `workflowEdges` (implementation, triage, verification, wiki, archive) and in the openspec/fusion/wiki/research graphs, moving each loop budget onto the edge that enters the route step. Verify with a focused graph test asserting one inbound edge per classifiable step, that it comes from the route step, and that no unclassifiable step gained one.
- [x] 3.2 Register the tier `definitionVersionForStepRouting(rounds) = rounds + 700` for every family in `registerBuiltins`, and assert a new start resolves it while earlier tiers are untouched. Verify with a focused registry test that the new tier's definitions are routable end to end and that a definition pinned to `rounds + 600` still resolves its own steps and digest.

## 4. Records, gates and fail-open

- [x] 4.1 Record each per-step routing decision with the step it selected for (existing `questionId`/`phase` fields kept meaningful) so the dashboard panel shows one row per agent step. Verify with a focused decision-record test and by rendering the panel for a run with two routed steps.
- [x] 4.2 Assert the unchanged contracts: a failed or unavailable classifier completes the route step and keeps the pinned default, gates and triage-role selection are untouched, and no run parks on a route step. Verify with focused fail-open, gate, and triage suites.

## 5. Configuration and verification

- [x] 5.1 Add the newly required pools to the effective presets (`private-subscription`, `eon-subscriptions`, the builtin preset) and to the test fixtures, with `core.research` in each. Verify that a research, wiki, and no-openspec start passes coverage validation, and that removing one pool fails with a message naming the step.
- [x] 5.2 Update the engine, e2e, startup and dashboard suites for the added route steps in their sequences. Verify with the full `bun run scripts/test.ts` pass.
- [x] 5.3 Run `bun run lint`, `bun run type-check`, `bun run test` and `bun run build` in `agentic-coding/` with zero diagnostics. Verify: clean runs and no failing test.
- [x] 5.4 Update `docs/workflow-architecture.md` (routing is per step, every family) and the routing section of `openspec/specs/classifier-model-pools/spec.md` after archiving.
