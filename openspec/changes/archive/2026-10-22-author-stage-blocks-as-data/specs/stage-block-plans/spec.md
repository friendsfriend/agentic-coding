## MODIFIED Requirements

### Requirement: Plans name blocks and typed arguments
A block plan SHALL consist of an optional typed `inputs` object and an ordered list of steps. Each step SHALL name a catalogued block id and an argument object; the block id MAY resolve to a checked-in block, an approved data block, or a draft that belongs to the calling run. A step argument MAY bind a plan input with exactly `{{ inputs.<name> }}` or an earlier step's output with exactly `{{ steps.<routeStepId>.outputs.<path> }}`; the placeholder SHALL be the whole string value and SHALL preserve the resolved type. A step MAY name a route step id from the approved stage plan. A plan MAY request that a rerunnable spec be saved only when it is the approved stage plan with a flow identity and a block on every route step; a standalone block plan SHALL be refused for saving because it has no reviewed flow identity. A plan SHALL NOT contain arbitrary JavaScript, selectors, expressions, branches, loops or parallel steps. A plan with more steps than the configured maximum SHALL be refused before argument resolution.

#### Scenario: A valid linear plan
- **WHEN** an agent submits a plan with `loginAsRole`, then `openCustomer`, then `fillCustomerAddress`
- **THEN** the runner SHALL accept the three ordered steps for validation

#### Scenario: Parameterized plan
- **WHEN** a plan declares `inputs: { customerId: "C-1001" }` and a step uses `{{ inputs.customerId }}`
- **THEN** validation SHALL accept the reference and execution SHALL pass `C-1001` to the block

#### Scenario: Standalone plan cannot be saved
- **WHEN** a standalone block plan with no approved stage plan identity requests `save: true`
- **THEN** validation SHALL refuse the save with `flow-identity-missing` and SHALL NOT write a spec

#### Scenario: Arbitrary code is refused
- **WHEN** a step argument contains a function, a script source, or a selector expression instead of a typed value
- **THEN** validation SHALL refuse the plan

### Requirement: Plan validation happens before browser access
`stage_run` SHALL validate a plan before opening a session, creating a page or performing any browser action. Validation SHALL check that every block id and version exists in the registry composed for the calling run, every argument matches the parameter schema after input and output references are resolved, every `{{ inputs.<name> }}` reference resolves to a declared plan input and preserves its type, the block's application scope matches the route application, all `requires` states are supplied by an earlier step or initial state, no `provides` state conflicts, every output reference resolves to an earlier step with the named output, and every write or destructive step is permitted by the stage's access policy and the approved plan. A block id that is only a draft SHALL resolve for the run that owns the draft and SHALL be reported as unknown for any other run. Validation SHALL return a bounded list of issues with the step index, block id and field.

#### Scenario: Unknown block
- **WHEN** a plan names a block id that is not in the catalog
- **THEN** `stage_run` SHALL return `block-unknown` with the step index and SHALL NOT open a browser

#### Scenario: Missing required state
- **WHEN** a plan starts with a block that requires `crm.customer.detail` but no earlier block provides it and the session does not already hold that state
- **THEN** validation SHALL fail with `block-requires-unmet` for that step

#### Scenario: Missing plan input
- **WHEN** a step uses `{{ inputs.customerId }}` but the plan declares no `customerId`
- **THEN** validation SHALL fail with `input-missing` for that step and field

#### Scenario: A draft resolves only for its own run
- **WHEN** the authoring run validates a plan that names its draft, and another run validates the same plan
- **THEN** the authoring run SHALL resolve the draft and the other run SHALL fail with `block-unknown`

### Requirement: Catalog and runner tools expose blocks
The system SHALL offer `stage_blocks` to search and describe the catalog, `stage_run` to validate and execute a plan, and `stage_block_save` to author a block as a draft of the calling run. `stage_blocks` SHALL return compact entries for a query, application, effect or limit, and SHALL return the full schema and examples when asked for a specific id. `stage_run` SHALL require a stage-bound session or a stage plus application context, SHALL support `dryRun: true` to validate without browser access, and SHALL be the only tool that executes a block plan. It SHALL accept either the approved `core.stage-test-plan@1` with block-backed route steps or a standalone `StageBlockPlan`; a stage plan SHALL be projected to the linear block plan internally with route step ids preserved, and a route step that names a block to create or to adjust SHALL participate exactly like a route step that names a block once the corresponding draft exists. The system SHALL NOT expose one tool per block.

#### Scenario: Search the catalog
- **WHEN** an agent calls `stage_blocks({ app: "crm", effect: "write", query: "address" })`
- **THEN** the result SHALL list matching blocks with id, title, version and effects, and SHALL omit the implementation source

#### Scenario: Dry run
- **WHEN** an agent calls `stage_run({ plan, dryRun: true })`
- **THEN** the result SHALL contain validation issues and resolved block versions without opening a browser

#### Scenario: Approved stage plan is projected
- **WHEN** `stage_run` receives a `core.stage-test-plan@1` whose route steps all name blocks
- **THEN** it SHALL execute the projected linear plan and preserve each route step id in the result

#### Scenario: A route step that names a block to create is executed
- **WHEN** the tester has saved the draft a route step names in `blockToCreate` and runs the approved plan
- **THEN** `stage_run` SHALL execute that draft under the approved route step id and record its proof

### Requirement: Plan approval is preserved
A block plan executed by the stage workflow SHALL remain tied to the approved `core.stage-test-plan@1`. The runner SHALL refuse a block whose effect or application was not declared in the approved route step. A developer comment or a plan revision SHALL invalidate a previously validated plan until it is re-approved. A draft block SHALL be executed only under the approved route step that names its id, version family and intent (or its adjustment reason), and SHALL NOT be executed under a different route step of the same plan. The plan result SHALL record the approved plan revision and the block versions that executed.

#### Scenario: Plan revision invalidates execution
- **WHEN** the plan is revised after approval and before `stage_run`
- **THEN** the runner SHALL refuse the previously validated plan until the revision is approved again

#### Scenario: Draft outside the approved route step is refused
- **WHEN** a plan step names a draft id that no approved route step declares
- **THEN** the runner SHALL refuse the step before opening a browser
