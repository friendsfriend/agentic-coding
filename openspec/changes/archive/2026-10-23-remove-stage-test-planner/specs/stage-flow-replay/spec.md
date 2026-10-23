## MODIFIED Requirements

### Requirement: Specs are generated from validated block plans and typed inputs
`stage_run({ plan, save: true })` SHALL generate a readable Playwright spec and a flow manifest only
after the plan passes normal block-plan validation, names a `flowId`, has an `inputs` object and has
a block on every step. It SHALL be the only flow authoring path and SHALL be available to the
`stage-tester` during `stage.execute`; there is no approved stage plan in the identity of a flow. The
spec SHALL import and call the same block functions and the same `StageContext` as the plan runner;
for a step whose block is a data block it SHALL instead call `stage.runData("<stepId>", { ...args })`
and import no block, because a data block has no export and no barrel entry. It SHALL map output
references to local variables, map every `{{ inputs.<name> }}` reference to `stage.input("<name>")`,
carry step ids for result mapping, contain a generated-file header, and be formatted and type-checked
before it is written. Generation SHALL write the files to the working tree only; it SHALL NOT commit,
push, open a pull request or edit a block. It SHALL write the document of every data block it pins to
`stage-flows/<flowId>/blocks/<blockId>.json`. The generator SHALL derive an input schema from the
input references and the receiving block parameter schemas. The spec SHALL NOT contain input values.
The generator SHALL refuse a plan with a step that does not name a block, a plan without a `flowId`,
a plan with a missing or incompatible input reference, a plan with a secret value in its arguments, a
plan whose output reference cannot be represented in the generated code, and a plan whose step names
a draft (`flow-block-draft`).

#### Scenario: Generate a parameterized replay flow
- **WHEN** the tester calls `stage_run({ plan, save: true })` for a plan with
  `flowId: "customer-address"`, an `inputs` object and blocks for every step
- **THEN** the system SHALL write `stage-flows/customer-address/flow.spec.ts` and `flow.json`, use
  `stage.input` for every parameter and return the flow id, route hash, input schema and generated
  file paths

#### Scenario: One flow, different values
- **WHEN** the same flow is generated with `customerId: "C-1001"` and later replayed with
  `customerId: "C-1002"`
- **THEN** the checked-in spec SHALL remain unchanged and both runs SHALL use the same route hash
  while reporting different `inputsHash` values

#### Scenario: Mixed plan cannot be saved
- **WHEN** a plan contains a step without a block and the agent asks to save it
- **THEN** the generator SHALL refuse the save with `flow-not-fully-blocked` and SHALL NOT write a
  spec

#### Scenario: A draft cannot be saved into a flow
- **WHEN** a step names a block that exists only as a draft of the run
- **THEN** the generator SHALL refuse the save with `flow-block-draft` and SHALL NOT write a spec

### Requirement: The flow manifest records the reviewed route and input contract
The generated `flow.json` SHALL record the flow id, title, stage or allowed stages, declared
applications and roles, the source plan id and, when the plan carried one, its revision, input
schema, input examples, route hash, spec hash, resolved block versions, block digests, the
step/block/input mapping, any expectation mapping the plan declared (which MAY be empty) and, for
every data block it pins, the flow-relative path of its document. The route hash SHALL cover the flow
id, step ids and order, application/role scope, block ids, canonical argument structure including
input placeholders and literal constants, output wiring, any expectation mapping and captures; it
SHALL NOT cover input values or a plan revision. A data block's digest SHALL cover its document body,
so editing the document makes the pin stale. The flow registry SHALL be built from the manifests and
SHALL fail the build when a manifest is missing a required field, a manifest id is duplicated, a
manifest names a block that is not in the catalog, a pinned data document is missing, unreadable or
invalid, the input schema is invalid or inconsistent with a step's input binding, or the checked-in
spec hash does not match the spec file. The build check SHALL validate every pinned data document and
its digest without a browser.

#### Scenario: Manifest is complete
- **WHEN** a flow is generated and checked in
- **THEN** the registry SHALL list it with its input schema, route hash, spec hash, block versions
  and block digests

#### Scenario: Route hash survives input changes
- **WHEN** a plan changes only its `inputs` values
- **THEN** the route hash SHALL remain unchanged and the flow SHALL not need regeneration

#### Scenario: Inconsistent input schema
- **WHEN** a manifest's input schema omits a type required by a step's input binding
- **THEN** the registry build SHALL fail before the flow can be replayed

#### Scenario: Hand-edited spec
- **WHEN** a generated spec is edited without regenerating its manifest
- **THEN** the build or registry check SHALL report a spec-hash mismatch

#### Scenario: A pinned data document is validated without a browser
- **WHEN** a flow pins a data block and its document is edited so the pinned digest no longer matches
- **THEN** the flow check SHALL report the digest mismatch and `stage_replay` SHALL refuse the flow

### Requirement: Replay eligibility is checked before execution
`stage_replay` SHALL refuse to execute a flow unless the pinned stage is allowed by the manifest and
declares the manifest's applications and roles, the checked-in spec hash matches the manifest, every
block version and block digest matches the registry, every pinned data document exists, is valid and
still hashes to its pinned digest, and the supplied `inputs` validate against the manifest's own
input schema with every required property present and no undeclared property. Eligibility SHALL be a
property of the manifest and the pinned stage alone: there is no approved plan and therefore no
route-hash, approved-input-hash or expectation-coverage comparison. A refusal SHALL name the first
drifted condition and SHALL NOT start a browser or a Playwright process. The tool SHALL NOT silently
substitute environment values or defaults for a refused input set; the caller SHALL be free to
correct the inputs, and a flow the tester has decided is wrong for the ticket SHALL simply not be
replayed.

#### Scenario: Drifted spec is refused
- **WHEN** a checked-in spec is edited so its hash no longer matches its manifest
- **THEN** `stage_replay` SHALL refuse the flow naming the spec hash and SHALL not start a process

#### Scenario: Different stage refused
- **WHEN** the workflow's pinned stage is `grid-int` and the flow manifest only allows `grid-uat`
- **THEN** `stage_replay` SHALL refuse the flow

#### Scenario: Inputs are validated against the manifest
- **WHEN** a caller supplies an input object with a missing required property
- **THEN** the tool SHALL refuse with the manifest schema issues and SHALL not start a process

#### Scenario: Stale pinned block
- **WHEN** a block a flow pins has a different version or digest in the registry
- **THEN** `stage_replay` SHALL refuse the flow

### Requirement: Replay executes without a model in the loop
`stage_replay({ flowId, stage, session?, inputs?, dryRun? })` SHALL start a separate Playwright
process for the checked-in spec and SHALL NOT call a model, a browser tool per step, or the plan
runner for that execution. When `inputs` is omitted the flow SHALL run with the manifest's input
examples or fail validation, and the answer SHALL state which values were used. A dry run SHALL
validate proposed inputs against the manifest schema without starting a browser. The process SHALL
receive the pinned stage, the declared applications and roles, the flow id, route hash and
`inputsHash`, a bounded run-input file, a short-lived run token rather than raw credentials, the
workflow evidence directory and run id, and the trace/video policy. The replay SHALL have a bounded
overall timeout and SHALL fail with `replay-timeout` if it exceeds it.

#### Scenario: Green replay
- **WHEN** an eligible flow runs with valid inputs and every test step passes
- **THEN** `stage_replay` SHALL return a completed result without a model turn per step

#### Scenario: Invalid input override
- **WHEN** a caller supplies inputs that violate the manifest input schema
- **THEN** the tool SHALL refuse before starting the process and name the schema issue

#### Scenario: Timeout
- **WHEN** the replay process exceeds its configured timeout
- **THEN** the run SHALL stop, store the partial result and evidence, and report `replay-timeout`

### Requirement: Replay returns a structured result contract
The replay SHALL write `stage-run.json` containing the flow id, plan id when the flow recorded one,
`inputsHash`, route hash, stage, overall status, start time, duration, per-step index and step id,
block id and version, status, duration, typed outputs, journal event offsets, evidence ids, failure
details, and timing data. The tool result SHALL expose the same structured fields in bounded form,
SHALL NOT include raw input values and SHALL NOT include a full page snapshot on success. A result
that does not match the contract SHALL be refused with `replay-result-invalid`. The generated
Playwright configuration SHALL bound a single browser action (`actionTimeout`, about 15 seconds) so a
hung action fails the test instead of running into the process timeout. A test that Playwright marks
as timed out, or that ends in a status other than `passed` while no step recorded a failure, SHALL
write a `failed` result whose failure names the step, block and open sub-step. A replay process that
exits non-zero while its result claims a pass SHALL be reported as a failed result with that named
failure, never as `replay-result-invalid`.

#### Scenario: Per-step results
- **WHEN** a flow with three steps succeeds
- **THEN** the result SHALL contain three step entries with their block ids, versions, durations and
  evidence ids

#### Scenario: Inputs are hashed, not echoed
- **WHEN** a flow runs with a customer address input set
- **THEN** the result SHALL contain `inputsHash` and SHALL not contain the raw address values

#### Scenario: Invalid result
- **WHEN** the replay process exits zero but writes a result missing a required field
- **THEN** the engine SHALL refuse the result with `replay-result-invalid` and SHALL not treat the
  flow as passed

#### Scenario: A timed-out action fails the flow
- **WHEN** a block action exceeds the replay action timeout
- **THEN** `stage-run.json` SHALL report `failed` with the failing step, block and sub-step, and the
  tool result SHALL carry that failure instead of a pass

#### Scenario: A hung process never reports a pass
- **WHEN** the replay process exits non-zero and its result still claims a pass
- **THEN** the engine SHALL report the flow as failed with a bounded reason and SHALL NOT refuse the
  result as invalid

### Requirement: Replay journal events and evidence are ingested by the server
The replay fixture SHALL write ordered events to a replay event file and evidence files plus a
manifest fragment to the run evidence directory; it SHALL NOT write `stage-journal.jsonl` or the
evidence manifest directly. The server SHALL validate the event and evidence schema, apply the shared
redactor, allocate journal sequence numbers, append entries to `stage-journal.jsonl`, merge the
evidence manifest and reject an event that cites an evidence id not present in the fragment or an
evidence file outside the run directory. The resulting entries SHALL carry `source: "replay"`, the
flow id, `inputsHash`, block id/version and step id beside the normal journal fields, so the tester
can cite them like any other step it ran. Raw plan inputs SHALL not be journalled unless a block
explicitly captured a value.

#### Scenario: Events become journal entries
- **WHEN** a replay emits three sub-step events
- **THEN** the server SHALL append three journal entries with the next sequence numbers, the replay
  source and the flow identity

#### Scenario: Unknown evidence
- **WHEN** a replay event cites an evidence id that is not in the manifest fragment
- **THEN** the server SHALL refuse the ingestion and the replay SHALL be reported as failed rather
  than partially journalled

### Requirement: Replay failure produces a bounded heal packet
On a failed replay, the engine SHALL write a bounded `stage-heal.json` packet with the flow id, the
plan id the flow recorded when it has one, `inputsHash`, failing step, block id and version, failing
sub-step, expected and observed text, retryability, evidence ids, trace path, scoped region and last
passing step, and SHALL return it in the `stage_replay` tool answer together with the failed result.
The stage workflow SHALL NOT edit a block or spec, recompile, commit, push or auto-promote a fix in
response to the failure, and it SHALL NOT enter a separate replay step. The tester SHALL receive the
packet in the same run and decide whether to report the failure, fix its own draft, or explore the
page itself. A reviewed code workflow MAY use the packet to heal the block, but the stage run SHALL
record the failure and evidence as it occurred.

#### Scenario: Failure packet
- **WHEN** a replay fails on the save sub-step of `fillCustomerAddress`
- **THEN** the tool answer SHALL carry a heal packet naming that block, version and sub-step plus the
  scoped snapshot, screenshot and trace

#### Scenario: No automatic repair
- **WHEN** a replay fails
- **THEN** no generated spec or block file SHALL be modified by the stage workflow

#### Scenario: The tester keeps working
- **WHEN** a replay fails mid-run
- **THEN** the tester SHALL continue in the same `stage.execute` run with the packet available and
  SHALL report the failure or its recovery in the report

## REMOVED Requirements

### Requirement: Replay can produce the existing report contract deterministically
**Reason**: The deterministic mapping existed to turn an approved route's replay into the report of a
`stage.replay` step. There is no approved route and no replay step: a replay is one more source of
journal entries and evidence that the tester cites in the report it writes itself.

**Migration**: `stage-blocks/replay-report.ts` and `mapReplayToReport` are deleted, and the plan's
`flowId`, `inputs` and `expectationIds` fields are removed with the `core.stage-test-plan@1`
contract. A replay's sub-steps already appear in the stage journal (`source: "replay"`) and evidence
store, which is what the report cites.
