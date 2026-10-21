## ADDED Requirements

### Requirement: Stage plans may name blocks per route step
A `core.stage-test-plan@1` route step MAY carry an optional `block` object containing a catalogued block id and typed arguments. The planner SHALL use a block when the catalog contains one that matches the step's application, role and intent, and SHALL leave the block absent when no suitable block exists. The human-readable `action`, `expected` result and `capture` values SHALL remain present for every step. A plan with no block references SHALL remain valid and SHALL execute exactly as before.

#### Scenario: Planner selects a block
- **WHEN** the planner needs to fill a customer address and the catalog contains `crm.customer.fillAddress`
- **THEN** the route step SHALL retain its action and expected text and SHALL carry `block: { id: "crm.customer.fillAddress", args: { ... } }`

#### Scenario: No block is available
- **WHEN** the catalog has no block for a step
- **THEN** the route step SHALL have no block reference and the plan SHALL remain valid

### Requirement: Plan review shows block effects
The plan review SHALL show, for each route step that names a block, the block id, version, title, effect set and the arguments that affect data creation. A write or destructive block SHALL count toward the plan's data-creation declaration for the existing approval gate. The review SHALL refuse a plan whose block effect set is broader than the plan's declared data creation, or whose block application is outside the pinned stage.

#### Scenario: Write block requires approval
- **WHEN** a plan names a `write` block and the stage's `planApproval` is `when-writing`
- **THEN** the plan SHALL stop at `stage.plan-review` and the review SHALL show the write effect

#### Scenario: Block outside the stage
- **WHEN** a route step names a block scoped to an application the pinned stage does not declare
- **THEN** the review SHALL refuse the plan with the application mismatch

### Requirement: Stage execution runs contiguous block steps through the plan runner
`stage.execute` SHALL execute a contiguous sequence of route steps that have block references through one `stage_run` call. A route step without a block SHALL remain an exploratory step executed with the existing browser tools. A transition between block and exploratory steps SHALL be a visible plan deviation in the execution result. The tester SHALL NOT replace a block step with free-form actions unless the block fails or the plan is revised and re-approved.

#### Scenario: All steps have blocks
- **WHEN** every route step in the approved plan names a block
- **THEN** `stage.execute` SHALL run them through one `stage_run` call and SHALL not require a `browser_snapshot` between steps

#### Scenario: Mixed route
- **WHEN** the first two route steps name blocks and the third does not
- **THEN** `stage.execute` SHALL run the first two through `stage_run` and the third through the exploratory browser tools, and the result SHALL record the switch

### Requirement: Stage reports consume block execution results
The `core.stage-report@1` path SHALL accept the block runner's step and journal ids as plan step ids and evidence ids. The report SHALL include the block id and resolved version for each block-backed step, the failing sub-step for a failure, and every block-to-exploratory deviation. A report that cites a step id or evidence id not produced by the runner or the exploratory tools SHALL be refused by the existing engine validation.

#### Scenario: Report includes block versions
- **WHEN** a block-backed step passes and the report cites its journal entry
- **THEN** the report SHALL name the block id and version beside the reproduction step

#### Scenario: Report names a deviation
- **WHEN** a plan switches from a block step to an exploratory step
- **THEN** the report SHALL list the switch under what was not tested as planned and why

### Requirement: Block failures return to the plan owner before the report
When a block fails, `stage.execute` SHALL return to the stage workflow with a structured block failure rather than silently continuing. The tester SHALL either record the failure against the expectation, request a plan revision, or complete the report with a `fail` or `blocked` verdict. The workflow SHALL NOT auto-promote a block fix or auto-approve a revised plan.

#### Scenario: Block failure is reported
- **WHEN** `fillCustomerAddress` fails its postcondition
- **THEN** the tester SHALL record the failure against the mapped expectation with the block id, version and evidence ids

#### Scenario: Revised plan needs re-approval
- **WHEN** the plan owner changes a block argument in response to a failure
- **THEN** the revised plan SHALL pass through plan review again before execution
