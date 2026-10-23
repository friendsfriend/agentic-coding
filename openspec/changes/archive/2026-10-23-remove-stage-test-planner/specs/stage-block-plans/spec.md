## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Plan approval is preserved
**Reason**: There is no approved `core.stage-test-plan@1` any more. The plan is the tester's own
working document for one `stage_run` call, the stage's `access` is the enforced write boundary, and
the developer's checkpoint is the report review after execution, where the claimed blocks and their
proofs are shown.

**Migration**: The `approvedRevision` request field, the `stage-plan-stale` refusal, the
`draftArgs` side channel and the "a draft is executable only by the approved route step that authored
it" rule are removed. A draft is executable by the run that owns it, and only the run's newest proof
of the exact document it holds can be claimed in the report.
