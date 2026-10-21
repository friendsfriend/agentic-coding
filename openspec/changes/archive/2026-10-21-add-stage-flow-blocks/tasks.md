## 1. Block contract and registry

- [x] 1.1 Add `src/stage-blocks/define-block.ts` with the `defineBlock` helper, `BlockDefinition`, `BlockMetadata`, `StageContext`, `BlockEffect` and `BlockStepEvent` types; validate ids, semver versions, schemas, effects, scope and examples at definition time
- [x] 1.2 Add the block registry loader that imports every public and internal block module once, rejects duplicate ids, and exposes lookup by id and resolved version
- [x] 1.3 Add JSON-schema conversion for the parameter and return schemas, including defaults, optional fields and the example-validation path
- [x] 1.4 Add the `StageContext` implementation over the existing allow-listed browser facade, including `step`, `capture`, `secret`, `expect`, run metadata, application and role
- [x] 1.5 Add unit tests for malformed definitions, duplicate ids, invalid examples and schema conversion

## 2. Generated catalog and build gate

- [x] 2.1 Add the catalog generator that writes the machine-readable manifest from the registry, sorted by id and excluding internal blocks
- [x] 2.2 Add the generated catalog artifact and a check that fails when the checked-in artifact differs from the generator output
- [x] 2.3 Add the catalog build gate that fails on a missing title, description, parameter schema, return schema, effect, scope, example or contract test
- [x] 2.4 Add compact and full catalog projections for the agent tool: compact entries omit schemas and examples; full entries include them
- [x] 2.5 Add tests for catalog filtering by application, effect, query and id, and for exclusion of source code and secrets

## 3. Block policy and versioning

- [x] 3.1 Add app-scope, effect and idempotency metadata to every block and enforce the metadata in the registry
- [x] 3.2 Add the policy checks for application mismatch, read-only stages, unapproved writes and destructive actions; return stable error codes
- [x] 3.3 Add the version resolver that records the executable version and refuses an unregistered id or version
- [x] 3.4 Add the contract-change check that detects parameter, return, scope, effect and required-state changes and requires a major version bump for breaking changes (`catalogBreakingChangeIssues`, wired into `scripts/generate-stage-blocks.ts` in both `--check` and write modes, so the gate runs on every `bun run build`)
- [x] 3.5 Add deprecation metadata (replacement id or removal date) and surface it in the catalog
- [x] 3.6 Add tests for each policy refusal and for a breaking change without a version bump

## 4. Plan schema and validation

- [x] 4.1 Add the `StageBlockPlan` schema with optional typed `inputs`, ordered steps, optional route step ids, args, `save` and bounded step count
- [x] 4.2 Add the input/output reference parser for exactly `{{ inputs.<name> }}` and `{{ steps.<routeStepId>.outputs.<path> }}`; reject functions, scripts, expressions and selectors
- [x] 4.3 Add pre-browser validation for unknown blocks, argument schemas, input bindings, app scope, `requires`/`provides`, output references, effects, approval and step count
- [x] 4.4 Add stable, bounded validation issues with step index, block id, field and error code, including `input-missing`
- [x] 4.5 Add dry-run support that returns validation issues and resolved versions without opening a browser
- [x] 4.6 Add tests for valid plans, parameterized plans, missing inputs, unknown blocks, unmet requirements, forward references, conflicting provides, invalid args, over-limit plans and dry-run

## 5. Plan runner and result contract

- [x] 5.1 Add the plan runner that resolves input and output references, executes steps in order and records the resolved block versions
- [x] 5.2 Add typed per-step results with index, route step id, block id, version, status, duration, outputs, journal ids and evidence ids
- [x] 5.3 Add stop-on-first-failure, retry of an idempotent read at most once, and no retry for a non-idempotent write or destructive block
- [x] 5.4 Add the execution result envelope with plan id, `inputsHash`, approved plan revision, stage, overall status, steps and failure details; keep raw inputs and full snapshots out of the success result
- [x] 5.5 Add a fake block context and runner tests for success, failure, retry, version resolution, input binding, output binding and the same plan with different inputs
- [x] 5.6 Add a consumer smoke test that chains at least three blocks and verifies the final postcondition (`test/stage-blocks.test.ts`'s pilot consumer smoke test: `loginAsRole` → `openCustomer` → `fillCustomerAddress` over a purpose-built fake page that distinguishes unsaved form state from server-persisted state across a reload)

## 6. Journal and evidence integration

- [x] 6.1 Add the `ctx.step` event buffer and translate events into journal entries with plan id, route step id, block id/version, sub-step label and sequence
- [x] 6.2 Reuse the existing journal writer, redactor, sanitized URL, evidence-manifest validation and sequence allocation; do not create a second journal format
- [x] 6.3 Add the block contract violation when a block emits no sub-step
- [x] 6.4 Add failure evidence capture: screenshot, scoped snapshot of the failing region, bounded console tail and bounded network tail
- [x] 6.5 Enforce the stage screenshot and recording limits on runner-captured evidence
- [x] 6.6 Add journal tests for sub-step order, block identity, redaction, unknown evidence ids, no-sub-step blocks and failure evidence limits

## 7. Agent tools

- [x] 7.1 Add the `stage_blocks` tool with query, app, effect, limit and id parameters; return compact entries by default and full schema/examples for one id
- [x] 7.2 Add the `stage_run` tool with plan, session, stage context, dryRun and save parameters; accept the approved stage plan or a standalone block plan, require a stage-bound session or stage plus application context, and refuse `save` for a standalone block plan with `flow-identity-missing`
- [x] 7.3 Add tool result shaping that keeps success results compact and failure results actionable without dumping a full page
- [x] 7.4 Add the tool descriptions and agent-facing examples to the stage executor/planner instruction surface (`stage_blocks`/`stage_run` in `stage-test-execute.md`'s block-first execution paragraph; `stage_blocks`/`stage_flows` in `stage-test-plan.md`'s block/flow-selection paragraphs; both tools' agent-host descriptions)
- [x] 7.5 Add contract tests for the tool request/response schemas and a test that no per-block tool is registered

## 8. Stage workflow integration

- [x] 8.1 Extend the `core.stage-test-plan@1` route-step schema with the optional `block` object and keep existing plans decodable
- [x] 8.2 Add the planner catalog lookup and the rule for choosing a block when it matches the step's application, role and intent (`stage-test-plan.md`; `stage_blocks`/`stage_flows` are both reachable read-only during `stage.plan` for the `stage-planner` role — `plannerDiscoveryTool` in `server/browser/routes.ts`)
- [x] 8.3 Add the plan-review projection for block id, version, title, effects and data-affecting arguments
- [x] 8.4 Add the execution path that runs contiguous block steps through `stage_run` and falls back to exploratory tools for gaps, recording each deviation (`plan-route-gap` per ungapped route step; `stage-test-execute.md`'s block-first paragraph; the tester records a gap as a plan-gap finding through the existing `stage_step` journal, not a second deviation format)
- [x] 8.5 Add the report projection for block id, version, route step id, journal ids, evidence ids and deviations (via the existing journal citation the report's `stepIds`/`evidenceIds` already use — no second, block-aware report schema)
- [x] 8.6 Add the stale-plan-revision refusal and the re-approval path after a block-related plan change
- [x] 8.7 Add workflow tests for an all-block plan, a mixed plan, a block failure, a stale revision and a report that cites runner ids

## 9. Pilot blocks and contract tests

- [x] 9.1 Implement `loginAsRole` with typed role and credential arguments, a login postcondition and contract test
- [x] 9.2 Implement `openCustomer` with a typed customer identifier, a detail-page postcondition and contract test
- [x] 9.3 Implement `fillCustomerAddress` with typed address arguments, a save postcondition, a reload check and contract test
- [x] 9.4 Add the consumer smoke test that chains the three pilot blocks against the pinned test stage (fake-context smoke test in `test/stage-blocks.test.ts`; a real-stage run is tracked by 9.6 below)
- [x] 9.5 Add examples for each pilot block and verify they validate against the parameter schemas
- [x] 9.6 Run the pilot flow through the current snapshot/action path and through `stage_run`; record turns, wall-clock, context growth and repair steps in the change notes — **intentionally descoped to follow-up**: the comparison needs a real pinned stage and a real agent run in both modes, which this change does not have; rather than fabricate numbers, the measurement is recorded as follow-up work outside this change's scope. Everything the comparison needs (the pilot blocks, the flow, the fake- and real-Playwright test coverage) is checked in for whoever runs it.

## 10. Documentation and verification

- [x] 10.1 Add `docs/stage-blocks.md` covering the contract, context, catalog, plan format, effects, versioning, contract tests and promotion path
- [x] 10.2 Update `agentic-coding/docs/workflow-architecture.md` with the block layer and the planner/executor boundary
- [x] 10.3 Update the stage planner and executor instructions with the block-first rule and the exploratory fallback
- [x] 10.4 Run `bun run lint`, `bun run type-check` and the focused block, plan, journal and workflow tests
- [x] 10.5 Run the pilot flow end to end on the pinned stage and attach the comparison notes to the change — **intentionally descoped to follow-up**, on the same terms as 9.6: the real-stage run did not happen here, and no comparison numbers are claimed.
