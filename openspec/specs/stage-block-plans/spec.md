# stage-block-plans Specification

## Purpose
TBD - created by archiving change add-stage-flow-blocks. Update Purpose after archive.
## Requirements
### Requirement: Plans name blocks and typed arguments
A block plan SHALL consist of an optional typed `inputs` object and an ordered list of steps. Each
step SHALL name a catalogued block id and an argument object; the block id MAY resolve to a
checked-in block, an approved data block, or a draft that belongs to the calling run. A step argument
MAY bind a plan input with exactly `{{ inputs.<name> }}` or an earlier step's output with exactly
`{{ steps.<routeStepId>.outputs.<path> }}`, where the referenced step id is the `id` of an earlier
step of the same plan; the placeholder SHALL be the whole string value and SHALL preserve the
resolved type. A step MAY carry an `id` the caller chooses, and the runner SHALL preserve it in the
result and the journal. A plan that names a `flowId` MAY request that a rerunnable spec be saved; a
plan without a flow identity SHALL be refused for saving because it has no reviewed flow identity. A
plan SHALL NOT contain arbitrary JavaScript, selectors, expressions, branches, loops or parallel
steps. A plan with more steps than the configured maximum SHALL be refused before argument
resolution.

#### Scenario: A valid linear plan
- **WHEN** an agent submits a plan with `loginAsRole`, then `openCustomer`, then `fillCustomerAddress`
- **THEN** the runner SHALL accept the three ordered steps for validation

#### Scenario: Parameterized plan
- **WHEN** a plan declares `inputs: { customerId: "C-1001" }` and a step uses `{{ inputs.customerId }}`
- **THEN** validation SHALL accept the reference and execution SHALL pass `C-1001` to the block

#### Scenario: Plan without a flow identity cannot be saved
- **WHEN** a plan with no `flowId` requests `save: true`
- **THEN** validation SHALL refuse the save with `flow-identity-missing` and SHALL NOT write a spec

#### Scenario: Arbitrary code is refused
- **WHEN** a step argument contains a function, a script source, or a selector expression instead of a
  typed value
- **THEN** validation SHALL refuse the plan

### Requirement: Plan validation happens before browser access
`stage_run` SHALL validate a plan before opening a session, creating a page or performing any browser
action. Validation SHALL check that every block id and version exists in the registry composed for
the calling run, every argument matches the parameter schema after input and output references are
resolved, every `{{ inputs.<name> }}` reference resolves to a declared plan input and preserves its
type, the block's application scope matches one of the applications the pinned stage declares, all
`requires` states are supplied by an earlier step or initial state, no `provides` state conflicts,
every output reference resolves to an earlier step with the named output, and every write or
destructive step is permitted by the stage's access policy. A block id that is only a draft SHALL
resolve for the run that owns the draft and SHALL be reported as unknown for any other run.
Validation SHALL return a bounded list of issues with the step index, block id and field.

#### Scenario: Unknown block
- **WHEN** a plan names a block id that is not in the catalog
- **THEN** `stage_run` SHALL return `block-unknown` with the step index and SHALL NOT open a browser

#### Scenario: Write block on a read-only stage
- **WHEN** a plan names a `write` block and the pinned stage is `read-only`
- **THEN** validation SHALL refuse the plan before any browser action

#### Scenario: Own draft is executable
- **WHEN** the run has saved a draft and its plan names that block
- **THEN** validation SHALL resolve the draft's document and SHALL execute it

### Requirement: Plan execution returns structured step results
`stage_run` SHALL execute a validated plan in one tool call and return a structured result containing a plan id, an `inputsHash` of the resolved plan inputs, overall status, the resolved stage, each step's index, route step id if present, block id and version, status, duration, typed outputs, journal entry ids and evidence ids, plus the failure details when the plan stops. The result SHALL NOT include a full page snapshot or raw input values on success.

#### Scenario: Successful plan
- **WHEN** all plan steps succeed
- **THEN** the result SHALL report `status: "complete"` and one result per step with its outputs and journal ids

#### Scenario: Step failure
- **WHEN** the second block fails its postcondition
- **THEN** the result SHALL report `status: "failed"`, identify the second step and failing sub-step, and include the first step's completed outputs

### Requirement: Input and output references bind values
A step argument MAY bind a declared plan input using exactly `{{ inputs.<name> }}` or an earlier step's typed output using exactly `{{ steps.<routeStepId>.outputs.<path> }}`. An input reference SHALL resolve to a value in the plan's `inputs`; an output reference SHALL resolve only to an earlier step and to a declared return field. Both SHALL preserve the field's type. A missing or unknown input, a forward or unknown output, a reference to a non-output field, or a reference whose value does not satisfy the receiving parameter schema SHALL fail validation.

#### Scenario: Customer id is carried forward
- **WHEN** `openCustomer` returns `customerId` and a later step uses `{{ steps.open-customer.outputs.customerId }}`
- **THEN** the runner SHALL pass the resolved value to the later block

#### Scenario: Plan input is reused
- **WHEN** two steps use `{{ inputs.postalCode }}` and the plan supplies a valid string
- **THEN** both steps SHALL receive the same resolved value

#### Scenario: Forward reference
- **WHEN** a step references an output of a later step
- **THEN** validation SHALL refuse the plan with `output-reference-forward`

### Requirement: Plan inputs are reusable test data, not credentials
A plan input SHALL be a typed test value and SHALL NOT be used to carry a credential; a block that needs a credential SHALL resolve it through `ctx.secret(name)`. The runner SHALL validate input values against the resolved argument schema, SHALL redact plan inputs before logging or journalling, and SHALL return only an `inputsHash` in the result. The approved plan MAY retain the input values for review, but a journal entry SHALL contain a value only when a block explicitly captured it. The same plan structure SHALL be executable with a different input object without changing the block sequence.

#### Scenario: Same plan, different inputs
- **WHEN** the same validated plan is executed with `customerId: "C-1001"` and later with `customerId: "C-1002"`
- **THEN** both runs SHALL use the same block sequence and SHALL report different `inputsHash` values

#### Scenario: Credential is not a plan input
- **WHEN** a plan input would carry a password and a block needs that password
- **THEN** the block SHALL resolve the credential through `ctx.secret` and the plan input SHALL not contain the secret

### Requirement: Runner writes journal entries and evidence
The runner SHALL translate each `ctx.step` event into a `stage-journal.jsonl` entry using the journal's existing sequence, timestamp, session, application, role, sanitized URL, label, expected, observed, captures, evidence ids and knowledge-observation rules. Every entry SHALL pass through the shared redactor. A referenced evidence id that does not exist SHALL be refused. A block SHALL emit at least one sub-step; a block that emits none SHALL be recorded as a contract violation. On failure, the runner SHALL store a screenshot and a scoped snapshot of the failing region, plus a bounded console and network tail, and SHALL return their evidence ids.

#### Scenario: Sub-steps are journalled
- **WHEN** a block emits `ctx.step("open customer")` and `ctx.step("save address")`
- **THEN** the journal SHALL gain two ordered entries naming the block id and version, without a separate `stage_step` model call

#### Scenario: Failure evidence
- **WHEN** a block fails on a save action
- **THEN** the result SHALL include a screenshot evidence id, a scoped snapshot evidence id and the failing sub-step, and the journal SHALL record the failure

### Requirement: Failure semantics are bounded and explicit
The runner SHALL stop a plan at the first failed step by default. It SHALL NOT retry a non-idempotent write or destructive block. It MAY retry an idempotent read block once on a transient browser failure and SHALL record the retry. A failure result SHALL name the block id and version, the failing sub-step, expected and observed text, whether the failure is retryable, and the evidence ids. The runner SHALL NOT automatically heal, edit a block, or continue past a failed step.

#### Scenario: First failure stops the plan
- **WHEN** step three fails after steps one and two succeed
- **THEN** step four SHALL NOT execute and the result SHALL identify step three

#### Scenario: Non-idempotent write is not retried
- **WHEN** a `write` block with `idempotent: false` fails with a timeout
- **THEN** the runner SHALL report the failure without a second attempt

### Requirement: Stage policy applies to block effects
The runner SHALL apply the stage's existing access policy to every block. A write block SHALL require
a `writable` stage; the stage's `access` is the only write boundary and no separate plan approval is
consulted. A read-only stage SHALL refuse a write or destructive block. A destructive block SHALL be
refused wherever it is named. A plan SHALL NOT use a block scoped to an application outside the
pinned stage. A refusal SHALL occur during validation, before any browser action, whenever the policy
can be evaluated from metadata.

#### Scenario: Write on a writable stage
- **WHEN** a plan on a `writable` stage names a `write` block
- **THEN** validation SHALL accept the step and the run SHALL execute it

#### Scenario: Read-only stage
- **WHEN** a read-only stage plan includes a destructive block
- **THEN** validation SHALL fail with `stage-read-only`

### Requirement: Catalog and runner tools expose blocks
The system SHALL offer `stage_blocks` to search and describe the catalog, `stage_run` to validate and
execute a plan, and `stage_block_save` to author a block as a draft of the calling run. `stage_blocks`
SHALL return compact entries for a query, application, effect or limit, and SHALL return the full
schema and examples when asked for a specific id. `stage_run` SHALL require a stage-bound session or
a stage plus application context, SHALL support `dryRun: true` to validate without browser access,
and SHALL be the only tool that executes a block plan. It SHALL accept only a standalone
`StageBlockPlan` document; there is no second plan form, no approved-plan projection and no separate
argument channel. The system SHALL NOT expose one tool per block.

#### Scenario: Search the catalog
- **WHEN** an agent calls `stage_blocks({ app: "crm", effect: "write", query: "address" })`
- **THEN** the result SHALL list matching blocks with id, title, version and effects, and SHALL omit
  the implementation source

#### Scenario: Dry run
- **WHEN** an agent calls `stage_run({ plan, dryRun: true })`
- **THEN** the result SHALL contain validation issues and resolved block versions without opening a
  browser

#### Scenario: A saved draft is executed from the plan
- **WHEN** the tester saved a draft with `stage_block_save` and names it in a plan step with its own
  arguments
- **THEN** `stage_run` SHALL execute that draft under that step id and record its proof

### Requirement: Plans are linear and composable only by sequencing
A plan SHALL express composition only by ordering steps. Branching, loops, conditional steps and parallel steps SHALL NOT be part of a plan. A flow that needs control flow SHALL use multiple plans or a generated Playwright spec. A plan MAY be reused as a step list by another plan only through a catalogued block, not by textual inclusion of another plan.

#### Scenario: Branch is refused
- **WHEN** a plan step contains a condition or an `if` branch
- **THEN** validation SHALL refuse the plan

#### Scenario: Reuse through a block
- **WHEN** two plans need the same three-step sequence
- **THEN** the sequence SHALL be extracted into a block and both plans SHALL name that block

