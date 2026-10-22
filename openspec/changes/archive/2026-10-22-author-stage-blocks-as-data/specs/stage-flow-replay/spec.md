## MODIFIED Requirements

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
