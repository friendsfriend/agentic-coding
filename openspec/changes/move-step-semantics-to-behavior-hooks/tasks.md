## 1. Preconditions and baselines

- [ ] 1.1 Re-verify stage A's delivered seam before writing any hook: confirm `StepBehavior` in `agentic-coding/src/workflow/steps/types.ts` and `StepDefinition.behavior` in `registry.ts` exist with the shape this design assumes, and record any deviation. Verify by running `bun test test/workflow-steps.test.ts` and confirming stage A's pinned-digest snapshot still passes.
- [ ] 1.2 Capture a developer-action parity baseline in `test/workflow-steps.test.ts`: for every step and every definition id, assert the current engine action list (ids, labels, confirmation kinds, and input schema ids) equals literal values committed in the test, including both existing `core.wiki-approval` branches and the `core.completed` close-only allowlist. Verify it passes against unmodified source.
- [ ] 1.3 Capture a context carry-over parity baseline: for each of the five carry-over clauses and for every adjacent precedence pair where two clauses match the same transition, assert the resulting `step.context`. Verify it passes against unmodified source.

## 2. Entry guards

- [ ] 2.1 Add the `validateEvidence` hook to `StepBehavior` and invoke it from `validateStepEvidence`, which becomes a delegation. Verify stage A's digest snapshot still passes.
- [ ] 2.2 Move the planning-artifact guard into the planning step module for `core.plan` and `fusion.consolidate`, preserving the `entry-guard` error code and exact message. Verify with `bun test test/workflow-runtime.test.ts -t "entry-guard"`.
- [ ] 2.3 Move the implementation completed-`tasks.md` guard, including its `definition.id !== "no-openspec"` exemption, into the implementation step module. Verify the guard throws for OpenSpec definitions and does not for `no-openspec`.
- [ ] 2.4 Move the archive move-detection guard into the lifecycle step module. Verify with the existing archive entry-guard cases.
- [ ] 2.5 Confirm `validateStepEvidence` contains no step identifier. Verify with `rg '"core\.' src/workflow/runtime.ts` showing no match inside that function.

## 3. Arrival semantics

- [ ] 3.1 Add the `onArrive` hook with the `prior: { attempt, results, context }` context from design D2, and invoke it from `transition()` after the edge and fresh step are applied. Verify with `bun test test/workflow-runtime.test.ts`.
- [ ] 3.2 Implement the ordered context carry-over resolver from design D3 as one explicit precedence list, with steps opting in via declared flags. Verify with the task 1.3 baseline — every clause and every adjacent-pair precedence case must produce an identical context.
- [ ] 3.3 Move the `fusion.plan` self-loop draft-preservation rule into the planning step module. Verify with `bun test test/workflow-plan-fusion.test.ts`.
- [ ] 3.4 Move the `core.triage` and `core.verification` round-counter seeding and the `selectedRoles` extraction with its empty-selection `testRunStarted` shortcut into the verification step module. Verify round numbering and role selection across a full verification loop with `bun test test/workflow-e2e.test.ts`.
- [ ] 3.5 Move the `core.plan` and `core.implementation` `step.mode` assignment into their step modules. Verify `review-fix`, `fix`, and `apply` are each produced for the correct inbound outcome.
- [ ] 3.6 Move the `core.completed` and `core.closed` workflow status assignment into the lifecycle step module. Verify terminal status for every definition with `bun test test/workflow-e2e.test.ts`.
- [ ] 3.7 Confirm `transition()` contains no step identifier. Verify with a scoped `rg` over that function showing no match.

## 4. Entry effects

- [ ] 4.1 Add the `onEnter` hook receiving `{ snapshot, enqueue, hasLiveRun }` per design D4 — no database handle. Verify with `bun run type-check` that no step module can reference `Database`.
- [ ] 4.2 Move the `core.delivery` `delivery.commit` and `core.closed` `workspace.close` enqueues into the lifecycle step module, preserving the exact idempotency key format. Verify with `bun test test/workflow-effects.test.ts` that keys and payloads are unchanged.
- [ ] 4.3 Move the `fusion.plan` relaunch-skip rule (skip a role with a surviving validated draft or a live pending/working run) into the planning step module using `hasLiveRun`. Verify with `bun test test/workflow-plan-fusion.test.ts` covering a partial-failure retry.

## 5. Developer actions

- [ ] 5.1 Add the `developerActions` hook and reduce `actions()` to a delegation plus the engine-owned `status === "paused"` → `resume` short-circuit. Verify with the task 1.2 parity baseline.
- [ ] 5.2 Move each approval step's actions into its step module, collapsing the two `core.wiki-approval` branches into one declaration. Verify the parity baseline still passes and that `core.wiki-approval` resolves identically for the `research` definition and for every other definition that reaches it.
- [ ] 5.3 Move the `core.research` `research-follow-up` and `close-research` actions, including the rule that `close-research` is offered only while the current step is `core.research`, into the research step module. Verify with `bun test test/workflow-runtime.test.ts -t "close-research"`.
- [ ] 5.4 Move the `core.completed` `create-pr` / `close` actions and their close-only allowlist into the lifecycle step module. Verify the allowlist still contains all five definition ids including `wiki-comments`.

## 6. Branches outside the engine

- [ ] 6.1 Audit each step-identity branch in `effect-runner.ts` (lines ~1054, 1294, 1323, 1426, 1442) and `assignment.ts` (~line 184) and record its actual required inputs per design D5, before writing the hook. Deliver the audit as a short table in the change's design notes; any branch needing more than `{ snapshot, run }` is recorded as out of scope and left in place.
- [ ] 6.2 Add `assignmentInputs` and `instructionAssetForRole` hooks and move the in-scope branches. Replace `assignment.ts`'s `{ wiki: "wiki-openspec.md", "research-wiki": "wiki-research.md" }` map with `instructionAssetForRole`, keeping each step's pinned `instructionAssets` array unchanged so instruction digests do not move. Verify with `bun test test/workflow-effects.test.ts test/workflow-adapters.test.ts`.
- [ ] 6.3 Replace the `["core.triage", "core.verification"]` literal in `effect-runner.ts` with a declared round-scoping flag read from the step. Verify round-scoped pane and artifact grouping is unchanged with `bun test test/workflow-effects.test.ts test/workflow-cli.test.ts`.
- [ ] 6.4 Confirm no file outside `src/workflow/steps/` branches on a `core.*` or `fusion.*` step identifier, excluding `definitions.ts` manifest step lists and output schema ids. Verify with a scoped `rg` over `src/workflow/` and `src/tui/` and record the remaining permitted matches.

## 7. Declarative workflow policy

- [ ] 7.1 Add the validated `policy` block to `WorkflowManifest` in `registry.ts` (target kind, checkout requirement, read-only-researcher requirement), rejecting an unknown target kind or contradictory combination at registration. Verify with focused registry cases asserting the rejection names the manifest.
- [ ] 7.2 Declare policy on every built-in manifest and register the policy-bearing definitions under a new version per design D1, leaving prior versions registered. Verify a parity test asserts every prior definition version still resolves with its original digest.
- [ ] 7.3 Replace the engine's `isWikiWorkflowTarget` / `isResearchWorkflowTarget` / definition-id array checks at start time with reads of the pinned definition's policy. Verify with `bun test test/workflow-runtime.test.ts` covering wiki, research, and repository targets, including the read-only researcher boundary.
- [ ] 7.4 Verify a workflow pinned to a pre-policy definition version still dispatches without repair, using a store fixture pinned to the prior version.

## 8. Documentation and change-relevant validation

- [ ] 8.1 Update `agentic-coding/docs/workflow-architecture.md`: mark stages B's branches as moved, record the context carry-over precedence list, and state the manifest-policy version-bump rule. Verify the outstanding-branch list matches what task 6.4 recorded.
- [ ] 8.2 Run the focused suites for the touched surface: `bun test test/workflow-steps.test.ts test/workflow-runtime.test.ts test/workflow-plan-fusion.test.ts test/workflow-e2e.test.ts test/workflow-effects.test.ts test/workflow-adapters.test.ts test/workflow-registry.test.ts test/workflow-cli.test.ts` and confirm all pass, including every parity baseline from group 1.
- [ ] 8.3 Run `bun run type-check`, then `bun run format` followed by `bun run lint` with zero diagnostics, then `bun run build`.
- [ ] 8.4 Run `openspec validate move-step-semantics-to-behavior-hooks --strict` and confirm it passes.
