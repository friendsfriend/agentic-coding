## Why

`add-stage-flow-blocks` removes the per-action browser loop for a single run: a
validated block plan executes in one `stage_run` call. It still costs a model turn
to start that call, and a stable flow that has already been planned, reviewed and
executed is still re-derived on every regression run.

The existing `browser_run_script({ save: true })` proves that a rerunnable
Playwright spec can be emitted, but that spec is an ad-hoc reproduction: it has no
block contract, no catalog, no plan identity and no workflow path. It cannot be
selected as a trusted regression, and a change to one step has no contract to
repair against.

The next step is to compile a reviewed block plan into a readable Playwright spec
that uses the same blocks, run that spec in CI or through a stage replay without a
model in the execution loop, and keep the agent for the two jobs that need
judgement: exploring a gap and healing a failure. This change builds on
`add-stage-flow-blocks` and is applied after it.

## What Changes

- Make one generated flow reusable with different parameters. A flow spec SHALL
  read typed inputs at runtime with `stage.input(name)`; input values SHALL live
  in the approved plan revision, not in the generated code. A later run with new
  values reuses the same spec and flow id, needs a new plan revision and approval,
  and SHALL NOT regenerate or re-review an unchanged route.
- Add spec generation from the approved stage plan's validated block route:
  `stage_run({ plan, save: true })` emits a Playwright `*.spec.ts` plus a sidecar
  flow manifest with the flow id, stage, source plan revision, input schema and
  examples, route hash, route-step mapping and resolved block versions. A
  standalone block plan may run but is not saveable as a flow.
- Generated specs SHALL call the same block functions and the same `StageContext`
  as the plan runner. They SHALL be readable, reviewed, checked in through a code
  workflow and not hand-edited; a changed route is regenerated from a changed
  plan. Generation SHALL write files but SHALL NOT commit, push or open a pull
  request on its own.
- Add a flow registry that lists saved flows by id, stage, application, input
  schema, route hash and block versions/digests, and classifies a flow as
  replay-eligible only when the pinned stage, approved plan route, input values
  and registered block code still match. Eligibility SHALL NOT compare input
  values as part of the route identity.
- Extend the existing `core.stage-test-plan@1` contract additively with optional
  `flowId`, `inputs` and per-route `expectationIds`; existing plans remain valid
  without a version bump. The extension lets a replay result map to the existing
  `core.stage-report@1` deterministically.
- Add a `stage.replay` workflow step that runs an eligible flow before the
  stepwise tester path. On success it produces the validated report; on failure
  it routes to `stage.execute` with a heal packet; on ineligibility it falls back
  to `stage_run` or the exploratory path with a reason.
- Add `stage_replay` for the stage tester: execute one saved flow by id with the
  approved plan inputs in a separate Playwright process, return structured
  per-step results, journal events and evidence ids, and do not spend a browser
  tool call per step. An input set that differs from the approved plan revision
  SHALL be refused, not silently substituted.
- Add a structured `stage-run.json` result contract: flow id, plan revision,
  `inputsHash`, stage, status, per-step block/version/status/duration, journal
  event offsets, evidence ids, failure details and timing. Raw input values SHALL
  NOT appear in the result. The engine ingests journal events and evidence
  through the existing journal/evidence stores rather than creating a second
  history.
- Add a deterministic success path: when every expectation is covered by a
  replay-eligible flow and all steps pass, the tester may map the structured result
  to the existing `core.stage-report@1` without re-reading the page. The engine
  still validates every cited journal step and evidence id.
- Add a bounded heal packet on failure: failing flow, block id/version, failing
  route step and sub-step, expected/observed, scoped snapshot, screenshot, trace,
  console tail, network tail and the last passing state. A stage run SHALL NOT
  edit a block or spec, auto-promote a fix or hide the failure; healing belongs to
  a reviewed code workflow.
- Add API-first setup, assertions and cleanup through the existing stage API
  surface: a block or replay fixture MAY use `ctx.api` for preconditions,
  verification and cleanup when the stage declares an API application and role.
  API calls SHALL use the same origin, role, method and read-only policy as
  `stage_api_request`, and a state-changing call SHALL count as a write effect.
- Add support for running a suite of independent saved flows in parallel, each in
  its own browser context and journal segment. A suite entry SHALL bind a flow id
  to its own input object, so the same flow can run more than once with different
  data. Flows that share created data or depend on order SHALL NOT be parallel;
  the suite manifest SHALL declare that boundary.
- Add CI usage: `bunx playwright test` on a saved flow or suite, typed inputs from
  a checked-in or CI-provided JSON file, trace/video on failure, structured results
  as an artifact, and no secrets in the spec, inputs or manifest.
- Keep the existing ad-hoc `browser_run_script` spec as a reproduction artifact.
  It is not a replay flow until it is promoted through a block and a reviewed
  plan.

## Capabilities

### New Capabilities

- `stage-flow-replay`: compiled spec generation, parameterized input schemas,
  flow manifest and registry, replay eligibility, the replay tool, structured
  results, journal/evidence ingestion, heal packets, API-first
  setup/assertions, parallel independent flows, CI execution and secret safety.

### Modified Capabilities

- `stage-test-workflow`: `stage.execute` may use a replay-eligible flow instead of
  the stepwise browser path; the report path consumes replay results; a failure
  returns a bounded heal packet; the plan approval and report validation rules
  remain in force.
- `stage-flow-journal`: replay journal events are appended with the same
  sequence, redaction and evidence rules as a live `stage_step`, and the flow
  timeline can identify the replay flow and block versions.

## Impact

- New `src/stage-blocks/spec/` (or equivalent) spec generator, fixture, flow
  manifest schema and registry.
- `src/stage-blocks/context.ts`: add the `api` surface for stage-declared API
  applications while keeping the existing origin, role and read-only policy.
- `src/agent-host/stage-tools.ts` or a sibling stage-replay tool module:
  `stage_replay`, flow listing and structured result shaping.
- `src/server/stages/` and `src/server/browser/`: a replay process boundary that
  can write journal events and evidence for ingestion; reuse the existing stage
  API client and evidence manifest.
- `src/workflow/steps/stage-test.ts`: replay eligibility in `stage.execute`,
  result ingestion, report mapping and failure routing.
- `agent-definitions/instructions/stage-test-execute.md`: replay-first execution
  and the failure packet; `stage-test-plan.md`: flow selection and saved-flow
  reuse.
- CI configuration and a `stage-flows/` checked-in repository of generated
  specs and manifests.
- Tests: parameterized spec generation, input-schema validation, manifest hashing,
  route-vs-input eligibility drift, replay execution, journal/evidence ingestion,
  report mapping, failure packet, API policy, repeated flow ids with different
  suite inputs, parallel suite isolation, secret redaction and the workflow path.
- Documentation: the flow authoring/review guide, parameterized inputs and plan
  revisions, replay eligibility, CI input files, heal packet and the boundary
  between a reproduction script and a replay flow.

## Non-Goals

- An LLM call inside a generated spec or a replay execution. The model may plan,
  explore and map a failure, but not drive a green replay.
- Automatic block/spec editing, auto-commit or auto-promotion after a failure.
- Replacing plan approval, stage policy, evidence retention or report
  validation.
- Using a flow input override to bypass the approved plan revision. New values
  require a new approved plan revision; the compiled spec stays the same.
- A browser-engine or CDP rewrite.
- Running arbitrary generated code from a plan at runtime. Only reviewed,
  checked-in specs and blocks are replay-eligible.
- Parallelising flows that share data, sessions or ordering.
