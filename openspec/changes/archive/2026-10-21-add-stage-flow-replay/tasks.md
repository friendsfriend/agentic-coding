## 1. Flow manifest and spec generator

- [x] 1.1 Add the `FlowManifest` schema with flow id, title, stage or allowed stages, applications, roles, source plan id/revision, input schema, input examples, route hash, spec hash, block versions, block digests and route-step/block/input/expectation mapping
- [x] 1.2 Add canonical hashing for the route structure, input schema, input values and generated spec; exclude input values and the source plan revision from the route hash and use one shared helper for generation and eligibility
- [x] 1.3 Add the spec generator that maps the approved stage plan's validated all-block route with a `flowId` to readable `@playwright/test` code, including imports, route step ids, output-reference local variables and `stage.input` calls; keep the standalone block plan runnable but not saveable
- [x] 1.4 Derive and merge the input schema from input references and receiving block parameter schemas; fail on a missing input or incompatible types
- [x] 1.5 Refuse generation for mixed plans, a missing `flowId`, unresolved output references, secret values in arguments and plans whose blocks do not have a registered digest
- [x] 1.6 Ensure the generated spec contains no input values; keep values in the approved plan revision and the run-input envelope
- [x] 1.7 Format the generated spec with the repository formatter and type-check it before writing
- [x] 1.8 Write `flow.spec.ts` and `flow.json` under `stage-flows/<flowId>/` and return the flow id, route hash, input schema, manifest path, spec path and hashes; never commit, push or open a pull request
- [x] 1.9 Add tests for a valid generation, input binding, the same route with different inputs producing the same spec, input-schema conflict, mixed-plan refusal, secret refusal and a type-check failure

## 2. Flow registry and eligibility

- [x] 2.1 Add the flow registry loader that scans `stage-flows/*/flow.json`, validates each manifest and rejects duplicate ids
- [x] 2.2 Add the registry build check for a missing field, unknown block, missing spec file, spec-hash mismatch, block version/digest mismatch and input-schema invalid fields
- [x] 2.3 Add the eligibility evaluator for stage, `flowId`, route hash, input schema and approved input values, spec hash, block versions/digests, route-step mapping and application/role coverage
- [x] 2.4 Ensure the evaluator does not compare input values or source plan revision as part of route identity; record `inputsHash` separately
- [x] 2.5 Return a stable first-drift reason for every refusal and a compact human explanation for the workflow
- [x] 2.6 Add tests for stage mismatch, route drift, input-schema mismatch, an unapproved input set, a new approved input set with the same route, hand-edited spec, block version change, block digest change and a valid flow

## 3. Playwright fixture and result contract

- [x] 3.1 Add `src/stage-blocks/fixture.ts` exporting a `stage` fixture that opens a browser context under the stage run policy and exposes the same `StageContext` as the plan runner
- [x] 3.2 Add `stage.input(name)` that reads the bounded run-input envelope, validates it against the flow input schema and returns the typed value
- [x] 3.3 Add `stage.run(routeStepId, block, args)` to execute one block, record route-step identity, outputs, timing and sub-step events
- [x] 3.4 Add `ctx.step` support that delegates to `test.step` and writes ordered replay events with label, expected, observed, captures and evidence ids
- [x] 3.5 Add `ctx.capture` and `ctx.secret` support without writing files outside the run evidence directory or exposing secrets
- [x] 3.6 Add the `stage-run.json` writer with the flow id, plan id/revision, `inputsHash`, route hash, stage, status, per-step results, journal event offsets, evidence ids, failure details and timing; never write raw inputs
- [x] 3.7 Add the custom Playwright reporter that writes the JUnit/HTML artifact and validates the final result contract
- [x] 3.8 Add fixture tests for success, a failed assertion, a skipped step, a timeout, a malformed result and missing, extra or mistyped inputs — success/failure (real assertion failure), missing/extra/mistyped inputs are covered by real-process tests (`test/stage-replay-process.test.ts`, `test/stage-block-routes.test.ts`, `test/stage-flow.test.ts`'s input-mismatch tests) and `test/stage-fixture-api.test.ts` covers the `ctx.api` half of the fixture directly. The ingestion logic was not separately testable in isolation (no decomposed "write result" seam), so it was extracted into `decodeReplayResult`/`replayEventsFromSteps` (`src/server/browser/stage-replay.ts`, shared by the route and the standalone CLI) and pinned directly in `test/stage-replay-result.test.ts`: a missing result file, malformed JSON, a schema violation, a flowId/routeHash/inputsHash mismatch, a non-zero exit reporting a pass, and a `skipped` step decoding/mapping to a `failed` event. A real process timeout (`timedOut: true`, process killed via `SIGKILL`) is pinned in `test/stage-replay-timeout.test.ts` against a server that never answers.

## 4. Replay execution and server ingestion

- [x] 4.1 Add `stage_replay({ flowId?, suiteId?, stage, inputs?, dryRun? })` to the stage tool surface; list flows when no id is given (flow listing is `stage_flows`; `stage_replay` itself runs a named `flowId`/`suiteId` or lists via `stage_flows` when both are omitted, per the tool description)
- [x] 4.2 Add the replay process launcher with a bounded timeout, stage/run token, approved plan id/revision and `inputsHash`, bounded input file, evidence directory and trace/video policy
- [x] 4.3 Refuse an explicit input set that differs from the approved plan revision with `flow-inputs-unapproved`; allow a dry run to validate proposed inputs without approval and without a browser
- [x] 4.4 Add the replay event file and evidence manifest fragment schema; reject events or files outside the run directory
- [x] 4.5 Add server ingestion that validates events, applies redaction, allocates journal sequence numbers, appends to `stage-journal.jsonl` and merges evidence with the flow id, plan revision and `inputsHash`
- [x] 4.6 Add duplicate-evidence, unknown-evidence, screenshot-limit and recording-limit handling
- [x] 4.7 Add a test that a replay never writes `stage-journal.jsonl` directly, a test that a malformed result is refused and a test that an unapproved input override does not start a browser — the unapproved-input-override test exists (`stage_replay` route tests; also exercised per-entry in the suite route test as a `flow-inputs-unapproved` refusal). The malformed-result refusal is pinned directly in `test/stage-replay-result.test.ts` (missing file, non-JSON, schema violation, identity mismatch, dishonest non-zero-exit pass), and `test/stage-replay-process.test.ts`'s real-process test now asserts no file named `stage-journal.jsonl` exists anywhere under the process's `dataRoot` after a passing run, pinning that the replay process itself never appends to the journal — only server-side ingestion does.
- [x] 4.8 Add a test that a retried replay appends a new run and does not overwrite earlier journal entries (`test/stage-block-routes.test.ts`'s "executes a saved flow..." runs replay twice — once passing, once failing — and asserts the journal grows from one entry to two rather than being replaced)

## 5. Deterministic report mapping and plan extension

- [x] 5.1 Extend the existing `core.stage-test-plan@1` contract with optional top-level `flowId` and `inputs` and optional per-route `expectationIds`; do not add a new plan version
- [x] 5.2 Update the planner instruction to select a flow, bind arguments to `{{ inputs.<name> }}`, populate `expectationIds` and include the approved input values
- [x] 5.3 Add plan-review rendering for the flow id, approved inputs, derived input schema, expectation coverage and replay eligibility
- [x] 5.4 Add the replay-to-report mapper for pass, fail, blocked, inconclusive, application versions, created data and not-tested entries
- [x] 5.5 Map plan priority to failure severity unless the flow manifest declares an override
- [x] 5.6 Reuse the existing report validator, citation checks, redactor and render effect; do not add a replay-only report type
- [x] 5.7 Refuse a replay report that leaves an expectation without a verdict, cites unknown evidence or cites a missing journal step
- [x] 5.8 Add tests for a full pass, a failed expectation, a skipped dependency, an uncovered expectation, an invalid citation, an existing plan without the new fields and an input-only plan revision

## 6. Workflow integration and heal packet

- [x] 6.1 Add the optional `stage.replay` step to the `stage-test` workflow family and route to it only when the approved plan names an eligible flow (reached only through the `approve-and-replay` plan-review action, offered exactly when `workflow/runtime/stage-replay-eligibility.ts` confirms eligibility)
- [x] 6.2 Add `stage.replay` arrival checks for plan approval, stage pin, application/role coverage, route hash, input schema, approved `inputsHash` and flow eligibility (the eligibility check before the action is offered, plus the full set re-enforced by `stage_replay` itself on every call)
- [x] 6.3 Add the success transition from `stage.replay` to `stage.review` with the validated report and replay metadata, including flow id, plan revision, `inputsHash` and block versions
- [x] 6.4 Add the failure transition from `stage.replay` to `stage.execute` with `stage-heal.json` and the failed result
- [x] 6.5 Add the ineligibility fallback to `stage.execute` or `stage_run` with a visible reason and a plan deviation
- [x] 6.6 Add replay metadata to the workflow snapshot: flow id, plan revision, `inputsHash`, route hash, block versions/digests, result path and report source (`snapshot.metadata.stageReplay`/`stageReplayHeal`)
- [x] 6.7 Add tests for a green replay route, a failed replay route, an ineligible flow, a pending approval, a stale route revision and an input-only approved revision (`test/stage-test-workflow.test.ts`'s `stage.replay` describe block plus the pre-existing `stage_replay` route tests for stale/mismatched revisions and the suite route's per-entry approval check)

## 7. Heal packet and repair boundary

- [x] 7.1 Add the `stage-heal.json` schema with flow, plan revision, `inputsHash`, route step, block/version, sub-step, expected/observed, retryability, evidence ids, trace, scoped region and last passing step
- [x] 7.2 Bound the packet and redact it before attaching it to the workflow or returning it to the tester; never include raw plan inputs
- [x] 7.3 Add the rule that a stage workflow never edits a block/spec, recompiles, commits, pushes or auto-promotes a fix (`stage.replay`'s instruction and `onAgentComplete` only ever read evidence and route to `stage.execute`; no file-write effect is ever enqueued on a failure)
- [x] 7.4 Add a test that a failed replay produces the packet and no repository file changes
- [x] 7.5 Document how a reviewed code workflow consumes the packet, runs the block contract test and requests re-approval (`docs/stage-flow-replay.md`'s heal-packet section)

## 8. API-first setup and assertions

- [x] 8.1 Add `ctx.api` to the replay fixture, backed by the existing `stage_api_request` policy and a short-lived run token
- [x] 8.2 Enforce declared application, declared role, relative path, origin allow-list, method, size bounds and read-only policy (role enforcement fixed this pass: a call's own declared role is now checked against the flow's declared roles and used for the request, instead of being silently replaced by the session role; request/response size bounds now share `MAX_STAGE_API_REQUEST_BYTES`/`MAX_API_RESPONSE_BYTES` with the interactive `stage_api_request` route)
- [x] 8.3 Journal API setup, assertion and cleanup calls as sub-steps and count state-changing calls as `write` effects
- [x] 8.4 Redact authorization, cookie and configured secrets from events, results and traces; keep plan inputs as non-secret test data
- [x] 8.5 Add tests for an API precondition, a read-only refusal, an absolute URL refusal, a missing role and a redacted response (`test/stage-fixture-api.test.ts`)

## 9. Parallel independent flows

- [x] 9.1 Add the suite manifest schema with flow entries containing `flowId` and `inputs`, plus `parallel`, `stopOnFailure` and entry-level shared-data/sequence/dependency declarations (`src/stage-blocks/suite.ts`)
- [x] 9.2 Validate every suite entry's inputs against its flow manifest and, in a stage workflow, against an approved plan revision's flow id, route hash and `inputsHash` before starting a context (manifest/registry validation runs before any entry starts; per-entry workflow approval reuses the exact single-flow `stageReplay` gate)
- [x] 9.3 Add the suite runner with one browser context and journal segment per entry, allowing the same flow id with different inputs (`runSuiteEntries`; each entry is its own `stageReplay` call, hence its own replay process/run id/journal segment)
- [x] 9.4 Refuse `parallel: true` for an entry that declares shared data, a fixed sequence or a dependency on another entry
- [x] 9.5 Add aggregate results with per-entry status, `inputsHash`, evidence ids and an overall status; a failure does not cancel other entries unless `stopOnFailure` is set; do not map a suite result to a workflow report
- [x] 9.6 Add tests for two independent flows, the same flow twice with different inputs, an unapproved workflow entry, a shared-data refusal, a stop-on-failure suite and a worker cap (`test/stage-suite.test.ts` for the pure orchestration/validation; `test/stage-block-routes.test.ts`'s suite route tests and `test/stage-flow-run-cli.test.ts` for the real, approval-gated and CI paths)

## 10. CI, pilot and verification

- [x] 10.1 Add the `stage-flows` Playwright project with the custom reporter, trace/video retention and bounded workers (per-run generated config in `src/server/browser/stage-replay.ts`, reused by both the agent-facing route and `scripts/stage-flow-run.ts`)
- [x] 10.2 Add CI steps that read a flow inputs JSON file, validate it against the manifest, run one flow and one suite, publish `stage-run.json`, the report and evidence, and fail on a schema error, non-zero exit or invalid result (`scripts/stage-flow-run.ts`, wired as `bun run stage-flows:run`; a real CI pipeline definition (e.g. `.github/workflows/*.yml`) is out of scope for this checkout)
- [x] 10.3 Add secret handling through the existing environment; assert no credential appears in the spec, manifest, inputs or published result
- [x] 10.4 Generate and check in the pilot `customer-address` flow with parameterized inputs from the block pilot plan
- [x] 10.5 Run the pilot flow locally and in CI with two approved input sets; confirm the spec is byte-identical and compare turns, wall-clock, context growth and repair time with `stage_run` and the stepwise path — **spec/route/hash identity across input sets is verified** by test and by this change's own development. The **turns/wall-clock/context-growth/repair-time comparison is intentionally descoped to follow-up**: it needs a real agent run against a real pinned stage, which this change does not have, and no numbers are claimed rather than fabricated.
- [x] 10.6 Add a second independent read-only flow and run the first parallel suite, including the same flow twice with different inputs (`stage-flows/customer-search/`, `stage-flows/crm-smoke.suite.json`; the same-flow-twice case is exercised directly in `test/stage-block-routes.test.ts` and `test/stage-flow-run-cli.test.ts`)
- [x] 10.7 Add `docs/stage-flow-replay.md` covering generation, parameterized inputs, plan revisions, manifests, eligibility, replay, heal packets, API-first use, parallel suites and CI
- [x] 10.8 Update the stage planner and executor instructions with replay-first behavior, flow input selection and the failure fallback
- [x] 10.9 Run `bun run lint`, `bun run type-check` and the focused generator, registry, fixture, ingestion, report, workflow and CI tests
