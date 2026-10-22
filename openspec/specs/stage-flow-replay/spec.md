# stage-flow-replay Specification

## Purpose
TBD - created by archiving change add-stage-flow-replay. Update Purpose after archive.
## Requirements
### Requirement: Specs are generated from validated block plans and typed inputs
`stage_run({ plan, save: true })` SHALL generate a readable Playwright spec and a flow manifest only after the approved `core.stage-test-plan@1` passes normal block-plan validation, names a `flowId`, has an `inputs` object, has `expectationIds` coverage and has a block on every route step. A standalone block plan MAY run without saving but SHALL NOT be saved as a flow. The spec SHALL import and call the same block functions and the same `StageContext` as the plan runner; for a route step whose block is a data block it SHALL instead call `stage.runData("<routeStepId>", { ...args })` and import no block, because a data block has no export and no barrel entry. It SHALL map output references to local variables, map every `{{ inputs.<name> }}` reference to `stage.input("<name>")`, carry route step ids for result mapping, contain a generated-file header, and be formatted and type-checked before it is written. Generation SHALL write the files to the working tree only; it SHALL NOT commit, push, open a pull request or edit a block. It SHALL write the approved document of every data block it pins to `stage-flows/<flowId>/blocks/<blockId>.json`. The generator SHALL derive an input schema from the input references and the receiving block parameter schemas. The spec SHALL NOT contain input values. The generator SHALL refuse a plan with a step that does not name a block, a plan without a `flowId`, a plan with a missing or incompatible input reference, a plan with a secret value in its arguments, a plan whose output reference cannot be represented in the generated code, and a plan whose route step names a draft (`flow-block-draft`).

#### Scenario: Generate a parameterized replay flow
- **WHEN** an agent calls `stage_run({ plan, save: true })` for a plan with `flowId: "customer-address"`, an `inputs` object, `expectationIds` covering every expectation and blocks for every route step
- **THEN** the system SHALL write `stage-flows/customer-address/flow.spec.ts` and `flow.json`, use `stage.input` for every parameter and return the flow id, route hash, input schema and generated file paths

#### Scenario: One flow, different values
- **WHEN** the same flow is generated from a plan with `customerId: "C-1001"` and then executed from a new approved plan revision with `customerId: "C-1002"`
- **THEN** the checked-in spec SHALL remain unchanged and both runs SHALL use the same route hash while reporting different `inputsHash` values

#### Scenario: Mixed plan cannot be saved
- **WHEN** a plan contains a route step without a block and the agent asks to save it
- **THEN** the generator SHALL refuse the save with `flow-not-fully-blocked` and SHALL NOT write a spec

#### Scenario: A draft cannot be saved into a flow
- **WHEN** a route step names a block that exists only as a draft of the run
- **THEN** the generator SHALL refuse the save with `flow-block-draft` and SHALL NOT write a spec

### Requirement: The flow manifest records the reviewed route and input contract
The generated `flow.json` SHALL record the flow id, title, stage or allowed stages, declared applications and roles, source plan id and revision, input schema, input examples, route hash, spec hash, resolved block versions, block digests, the route-step/block/input/expectation mapping and, for every data block it pins, the flow-relative path of its document. The route hash SHALL cover the flow id, route step ids and order, application/role scope, block ids, canonical argument structure including input placeholders and literal constants, output wiring, expectation mapping and captures; it SHALL NOT cover input values or the source plan revision. A data block's digest SHALL cover its document body, so editing the document makes the pin stale. The flow registry SHALL be built from the manifests and SHALL fail the build when a manifest is missing a required field, a manifest id is duplicated, a manifest names a block that is not in the catalog, a pinned data document is missing, unreadable or invalid, the input schema is invalid or inconsistent with a route input binding, or the checked-in spec hash does not match the spec file. The build check SHALL validate every pinned data document and its digest without a browser.

#### Scenario: Manifest is complete
- **WHEN** a flow is generated and checked in
- **THEN** the registry SHALL list it with its input schema, route hash, spec hash, block versions and block digests

#### Scenario: Route hash survives input changes
- **WHEN** a new plan revision changes only the `inputs` values
- **THEN** the route hash SHALL remain unchanged and the flow SHALL not need regeneration

#### Scenario: Inconsistent input schema
- **WHEN** a manifest's input schema omits a type required by a route input binding
- **THEN** the registry build SHALL fail before the flow can be replayed

#### Scenario: Hand-edited spec
- **WHEN** a generated spec is edited without regenerating its manifest
- **THEN** the build or registry check SHALL report a spec-hash mismatch

#### Scenario: A pinned data document is validated without a browser
- **WHEN** a flow pins a data block and its document is edited so the pinned digest no longer matches
- **THEN** the flow check SHALL report the digest mismatch and `stage_replay` SHALL refuse the flow

### Requirement: Replay eligibility is checked before execution
`stage_replay` SHALL refuse to execute a flow unless the pinned stage is allowed by the manifest, the approved plan names the manifest flow id, the approved plan's route hash matches, the approved plan's inputs validate against the manifest input schema with every required property present and no undeclared property, the checked-in spec hash matches, every block version and block digest matches the registry, every pinned data document exists, is valid and still hashes to its pinned digest, every plan route step maps to a manifest route step with a block, every planned expectation is covered, and the stage declares the manifest's applications and roles. A refusal SHALL name the first drifted condition and SHALL NOT start a browser or a Playwright process. The workflow SHALL fall back to the normal plan execution or require a recompile/re-approval; it SHALL NOT silently run the drifted flow or substitute different input values.

#### Scenario: Stage mismatch
- **WHEN** a flow is generated for `grid-int` and the approved plan pins `grid-uat`
- **THEN** `stage_replay` SHALL refuse with `flow-stage-mismatch` and the workflow SHALL use the normal execution path

#### Scenario: Block code changed
- **WHEN** a block's source changes but its recorded digest no longer matches the manifest
- **THEN** `stage_replay` SHALL refuse with a block-digest refusal even when the version string is unchanged

#### Scenario: Data block document changed
- **WHEN** a data block's document changes after a flow pinned it while its version string is unchanged
- **THEN** `stage_replay` SHALL refuse with the same block-digest refusal and SHALL NOT parse the pinned document as an older version

#### Scenario: New approved input values
- **WHEN** a new plan revision keeps the same route and supplies inputs that satisfy the manifest schema
- **THEN** `stage_replay` SHALL accept the flow without regenerating the spec

#### Scenario: Invalid input values
- **WHEN** the approved plan omits a required input, adds an undeclared input or supplies the wrong type
- **THEN** `stage_replay` SHALL refuse with `flow-input-schema-mismatch`

#### Scenario: Route drift
- **WHEN** a route step, block argument placeholder or expectation mapping changes
- **THEN** the route hash SHALL change and `stage_replay` SHALL require a regenerated flow and a new approval

### Requirement: Replay executes without a model in the loop
`stage_replay({ flowId, stage, session?, inputs?, dryRun? })` SHALL start a separate Playwright process for the checked-in spec and SHALL NOT call a model, a browser tool per step, or the plan runner for that execution. When `inputs` is omitted, the tool SHALL use the approved plan's inputs. An explicit input set in a workflow run SHALL match the approved plan's `inputsHash` or the tool SHALL refuse with `flow-inputs-unapproved`; new values require a new approved plan revision. A dry run MAY validate proposed inputs against the manifest schema without starting a browser and SHALL report that they are not approved. The process SHALL receive the pinned stage, the declared applications and roles, the approved plan id/revision and `inputsHash`, a bounded run-input file, a short-lived run token rather than raw credentials, the workflow evidence directory and run id, and the trace/video policy. The replay SHALL have a bounded overall timeout and SHALL fail with `replay-timeout` if it exceeds it.

#### Scenario: Green replay
- **WHEN** an eligible flow runs with the approved inputs and every test step passes
- **THEN** `stage_replay` SHALL return a completed result without a model turn per step

#### Scenario: Unapproved input override
- **WHEN** a workflow calls `stage_replay` with inputs whose hash differs from the approved plan revision
- **THEN** the tool SHALL refuse with `flow-inputs-unapproved` and SHALL not start the process

#### Scenario: Timeout
- **WHEN** the replay process exceeds its configured timeout
- **THEN** the run SHALL stop, store the partial result and evidence, and report `replay-timeout`

### Requirement: Replay returns a structured result contract
The replay SHALL write `stage-run.json` containing the flow id, plan id and revision, `inputsHash`, route hash, stage, overall status, start time, duration, per-step index and route step id, block id and version, status, duration, typed outputs, journal event offsets, evidence ids, failure details, and timing data. The tool result SHALL expose the same structured fields in bounded form, SHALL NOT include raw input values and SHALL NOT include a full page snapshot on success. A result that does not match the contract SHALL be refused rather than mapped to a report. The generated Playwright configuration SHALL bound a single browser action (`actionTimeout`, about 15 seconds) so a hung action fails the test instead of running into the process timeout. A test that Playwright marks as timed out, or that ends in a status other than `passed` while no step recorded a failure, SHALL write a `failed` result whose failure names the route step, block and open sub-step. A replay process that exits non-zero while its result claims a pass SHALL be reported as a failed result with that named failure, never as `replay-result-invalid`.

#### Scenario: Per-step results
- **WHEN** a flow with three steps succeeds
- **THEN** the result SHALL contain three step entries with their block ids, versions, durations and evidence ids

#### Scenario: Inputs are hashed, not echoed
- **WHEN** a flow runs with a customer address input set
- **THEN** the result SHALL contain `inputsHash` and SHALL not contain the raw address values

#### Scenario: Invalid result
- **WHEN** the replay process exits zero but writes a result missing a required field
- **THEN** the engine SHALL refuse the result with `replay-result-invalid` and SHALL not treat the flow as passed

#### Scenario: A timed-out action fails the flow
- **WHEN** a block action exceeds the replay action timeout
- **THEN** `stage-run.json` SHALL report `failed` with the failing route step, block and sub-step, and the tool result SHALL carry that failure instead of a pass

#### Scenario: A hung process never reports a pass
- **WHEN** the replay process exits non-zero and its result still claims a pass
- **THEN** the engine SHALL report the flow as failed with a bounded reason and SHALL NOT refuse the result as invalid

### Requirement: Replay journal events and evidence are ingested by the server
The replay fixture SHALL write ordered events to a replay event file and evidence files plus a manifest fragment to the run evidence directory; it SHALL NOT write `stage-journal.jsonl` or the evidence manifest directly. The server SHALL validate the event and evidence schema, apply the shared redactor, allocate journal sequence numbers, append entries to `stage-journal.jsonl`, merge the evidence manifest and reject an event that cites an evidence id not present in the fragment or an evidence file outside the run directory. The resulting entries SHALL carry the flow id, plan revision, `inputsHash`, block id/version and route step id beside the normal journal fields. Raw plan inputs SHALL not be journalled unless a block explicitly captured a value.

#### Scenario: Events become journal entries
- **WHEN** a replay step emits three sub-step events
- **THEN** the server SHALL append three journal entries with the next sequence numbers and the flow identity

#### Scenario: Unknown evidence
- **WHEN** a replay event cites an evidence id that is not in the manifest fragment
- **THEN** the server SHALL refuse the ingestion and the replay SHALL be reported as failed rather than partially journalled

### Requirement: Replay can produce the existing report contract deterministically
When a replay-eligible flow covers every planned expectation and all covering steps pass, the engine SHALL map the structured result to `core.stage-report@1` without requiring another page inspection: a passing expectation becomes `pass`, a failed covering step becomes `fail` with severity mapped from the plan priority unless the flow declares one, a step skipped after a dependency failure makes the expectation `blocked`, and an uncovered expectation becomes `inconclusive` with a reason. The plan SHALL use optional `flowId`, `inputs` and per-route `expectationIds` on the existing `core.stage-test-plan@1`; these fields SHALL be additive and existing plans without them SHALL remain valid. The report SHALL use the existing validation, citation, redaction and render path. If the flow cannot cover every expectation, the workflow SHALL route to the normal `stage.execute` tester instead of inventing a verdict.

#### Scenario: Deterministic pass report
- **WHEN** every expectation is covered by passing replay steps
- **THEN** the engine SHALL produce a report with one `pass` verdict per expectation, citing the replay evidence and journal ids

#### Scenario: Existing plan remains valid
- **WHEN** a `core.stage-test-plan@1` plan has no `flowId`, `inputs` or `expectationIds`
- **THEN** the plan SHALL remain valid for exploratory execution and SHALL not be replay-eligible

#### Scenario: Uncovered expectation
- **WHEN** a flow covers only two of three planned expectations
- **THEN** the engine SHALL mark the third `inconclusive` and SHALL not report the flow as a complete pass

### Requirement: Replay failure produces a bounded heal packet
On a failed replay, the engine SHALL write a bounded `stage-heal.json` packet with the flow id, plan revision, `inputsHash`, failing route step, block id and version, failing sub-step, expected and observed text, retryability, evidence ids, trace path, scoped region and last passing step. The packet SHALL be attached to the workflow and returned to the tester. The stage workflow SHALL NOT edit a block or spec, recompile, commit, push or auto-promote a fix in response to the failure. A reviewed code workflow MAY use the packet to heal the block, but the stage run SHALL record the failure and evidence as it occurred.

#### Scenario: Failure packet
- **WHEN** a replay fails on the save sub-step of `fillCustomerAddress`
- **THEN** the workflow SHALL receive a heal packet naming that block, version and sub-step plus the scoped snapshot, screenshot and trace

#### Scenario: No automatic repair
- **WHEN** a replay fails
- **THEN** no generated spec or block file SHALL be modified by the stage workflow

### Requirement: API-first setup and assertions use stage policy
The replay `StageContext` SHALL provide an API surface that reuses the existing `stage_api_request` rules: a declared API application, a declared role, a path relative to the application origin, bounded request and response sizes, read-only enforcement, authorization and secret redaction. A state-changing API call SHALL count as a `write` effect for plan validation and approval. API setup, assertion and cleanup steps SHALL be journalled as sub-steps. The fixture SHALL receive a short-lived run token and SHALL NOT embed a credential in the spec, manifest, inputs or result. Plan inputs SHALL be test data; a credential SHALL be resolved through `ctx.secret`.

#### Scenario: API precondition
- **WHEN** a flow creates a customer through the declared CRM API before the UI steps
- **THEN** the call SHALL be subject to the writable-stage policy, journalled, and its created id SHALL be usable by a later block

#### Scenario: Read-only refusal
- **WHEN** a flow on a read-only stage issues a state-changing API call
- **THEN** the call SHALL be refused with the existing read-only refusal and the flow SHALL report the failure

### Requirement: Parallel replay is limited to independent flow entries
A replay suite manifest SHALL list flow entries, each binding a flow id to its own input object, and SHALL declare whether entries may run in parallel. When parallel execution is requested, the runner SHALL validate each entry's inputs against its flow manifest and SHALL start each entry in its own browser context and journal segment. It SHALL cap concurrency by the lower of the suite worker count, `browser.max_sessions` and the CI worker setting. The same flow id MAY appear more than once with different inputs. The suite SHALL refuse `parallel: true` if any entry declares shared data, a fixed sequence or a dependency on another entry. A failed entry SHALL NOT cancel another entry unless the suite declares `stopOnFailure: true`; the suite result SHALL aggregate every entry's status and evidence. A suite run SHALL NOT produce a `core.stage-report@1`. In a stage workflow, every entry SHALL match an approved plan revision's `flowId`, route hash and `inputsHash`; an entry without that approval SHALL be refused. A standalone CI suite MAY use a reviewed input file and SHALL not claim a workflow report.

#### Scenario: Two independent flows
- **WHEN** two read-only flow entries declare independence and the suite runs with two workers
- **THEN** both SHALL run in separate contexts and the result SHALL aggregate both outcomes

#### Scenario: Same flow, different inputs
- **WHEN** a suite contains two entries for `customer-address` with different customer ids
- **THEN** both entries SHALL run with the same checked-in spec, separate contexts and distinct `inputsHash` values

#### Scenario: Unapproved workflow entry
- **WHEN** a stage workflow submits a suite entry whose flow, route or inputs do not match an approved plan revision
- **THEN** the suite SHALL refuse that entry and SHALL not produce a report

#### Scenario: Shared data refused
- **WHEN** a suite asks for parallel execution but an entry declares shared created data
- **THEN** the suite SHALL refuse the parallel run and explain the dependency

### Requirement: CI uses the same replay contract
A generated flow SHALL run as a normal `bunx playwright test` target with the same block fixture and result reporter used by `stage_replay`. CI SHALL supply flow inputs from a JSON file, validate them against the flow manifest before the test starts, and fail on a missing, extra or mistyped input. CI SHALL retain traces and videos on failure, publish `stage-run.json`, the human-readable test report and the evidence directory as artifacts, and fail the job on a non-zero test exit or an invalid result contract. CI SHALL provide stage credentials through the existing secret environment and SHALL NOT place a credential in the spec, manifest, inputs or result. A standalone CI run SHALL produce the result contract and SHALL not claim a `core.stage-report@1` unless it is tied to an approved plan revision and matching `inputsHash`.

#### Scenario: CI failure artifact
- **WHEN** a flow fails in CI
- **THEN** the job SHALL retain the trace, video, scoped snapshot, `stage-run.json` and the evidence directory and SHALL exit non-zero

#### Scenario: Invalid CI inputs
- **WHEN** the CI input file omits a required flow input
- **THEN** the job SHALL fail before the first block with an input-schema error

#### Scenario: No secret in artifacts
- **WHEN** a flow uses a stage credential
- **THEN** the spec, manifest, inputs and published result SHALL contain no credential value

### Requirement: Reproduction scripts are not replay flows
A spec saved by `browser_run_script({ save: true })` SHALL remain a reproduction artifact. It SHALL NOT be listed in the flow registry, SHALL NOT be replay-eligible and SHALL NOT be treated as covering a planned expectation until its steps are promoted into reviewed blocks and a generated flow.

#### Scenario: Ad-hoc script is not listed
- **WHEN** an agent saves a `browser_run_script` reproduction
- **THEN** `stage_replay` SHALL not list or execute it as a flow

#### Scenario: Promotion is required
- **WHEN** a reproducer is promoted to a flow
- **THEN** the flow SHALL be generated from a validated block plan and SHALL pass the flow-manifest checks

