## MODIFIED Requirements

### Requirement: Stage plans may name blocks per route step
A `core.stage-test-plan@1` route step SHALL name exactly one of: an optional `block` object containing a catalogued block id and typed arguments; a `blockToCreate` object (`id`, optional `version`, optional `args`, `intent`) describing the block the tester is to author for the step; a `blockToAdjust` object (`id`, optional `version`, optional `args`, `reason`) describing the existing approved data block to change; or a `noBlockReason` string. The planner SHALL author the plan blocks-first: it SHALL use a block when the catalog contains one that matches the step's application, role and intent, SHALL name a block to create when no block fits and the approach is already a block, SHALL name a block to adjust when an existing data block is close but wrong, and SHALL take `noBlockReason` only for an extreme edge case it states. The human-readable `action`, `expected` result and `capture` values SHALL remain present for every step. A route step that names none of the four SHALL be refused by the plan contract when the plan is submitted, so a plan persisted before this rule still decodes and resumes.

#### Scenario: Planner selects a block
- **WHEN** the planner needs to fill a customer address and the catalog contains `crm.customer.fillAddress`
- **THEN** the route step SHALL retain its action and expected text and SHALL carry `block: { id: "crm.customer.fillAddress", args: { ... } }`

#### Scenario: Planner names a block to create
- **WHEN** no catalogued block covers searching the postal code on the address page
- **THEN** the route step SHALL carry `blockToCreate: { id: "qa-ava.address.searchPostalCode", intent: "type the postal code and accept the suggestion" }` beside its action and expected text

#### Scenario: Planner names a block to adjust
- **WHEN** an approved data block fills the address but polls a selector that no longer exists
- **THEN** the route step SHALL carry `blockToAdjust: { id, version, reason }` instead of an exploratory step

#### Scenario: No block is available
- **WHEN** a step can only be verified with a tool the block surface does not offer
- **THEN** the route step SHALL carry a `noBlockReason` and the plan SHALL remain valid

#### Scenario: A route step with no block selection is refused
- **WHEN** a route step names no block, no block to create, no block to adjust and no `noBlockReason`
- **THEN** the plan contract SHALL refuse the plan and name the route step

### Requirement: Plan review shows block effects
The plan review SHALL show, for each route step that names a block, the block id, version, title, effect set and the arguments that affect data creation. For a route step that names a block to create or to adjust, the review SHALL show the intended id, version family, arguments and the stated intent or reason. A write or destructive block SHALL count toward the plan's data-creation declaration for the existing approval gate. The review SHALL refuse a plan whose block effect set is broader than the plan's declared data creation, or whose block application is outside the pinned stage, and the engine SHALL enforce both at plan completion from the registry the run executes against, not only in the rendered review.

#### Scenario: Plan names a write block without declaring data creation
- **WHEN** a plan names a `write` block and does not declare `createsData`
- **THEN** `stage.plan` completion SHALL refuse the plan and name the route step and the effect

#### Scenario: Plan names a destructive block
- **WHEN** a route step names a `destructive` block
- **THEN** `stage.plan` completion SHALL refuse the plan, because a destructive effect is never executable from a plan

#### Scenario: Write block requires approval
- **WHEN** a plan names a `write` block and the stage's `planApproval` is `when-writing`
- **THEN** the plan SHALL stop at `stage.plan-review` and the review SHALL show the write effect

#### Scenario: Block outside the stage
- **WHEN** a route step names a block scoped to an application the pinned stage does not declare
- **THEN** the review SHALL refuse the plan with the application mismatch

#### Scenario: Review shows the authoring intent
- **WHEN** the plan names a block to create for a read-only step
- **THEN** the review SHALL show the intended block id and its intent beside the route step and SHALL not require a block version

### Requirement: Stage execution runs contiguous block steps through the plan runner
`stage.execute` SHALL execute a contiguous sequence of route steps that have block references through one `stage_run` call, where a route step that names a block to create or to adjust SHALL count as block-backed once the corresponding draft exists. A route step without a block SHALL remain an exploratory step executed with the existing browser tools, and a route step whose block was never authored SHALL be reported as unblocked with its reason. A transition between block and exploratory steps SHALL be a visible plan deviation in the execution result. The tester SHALL NOT replace a block step with free-form actions unless the block fails or the plan is revised and re-approved.

#### Scenario: All steps have blocks
- **WHEN** every route step in the approved plan names a block
- **THEN** `stage.execute` SHALL run them through one `stage_run` call and SHALL not require a `browser_snapshot` between steps

#### Scenario: Mixed route
- **WHEN** the first two route steps name blocks and the third does not
- **THEN** `stage.execute` SHALL run the first two through `stage_run` and the third through the exploratory browser tools, and the result SHALL record the switch

#### Scenario: Authored step joins the block run
- **WHEN** the tester saves the draft a route step named in `blockToCreate`
- **THEN** the plan SHALL run that step through `stage_run` with the other block-backed steps and SHALL record its proof

#### Scenario: Unauthored step is reported unblocked
- **WHEN** a route step named a block to create and the tester completes without authoring it
- **THEN** the run SHALL record that step as unblocked with the tester's reason and the report SHALL NOT claim a block for it

### Requirement: Stage reports consume block execution results
The `core.stage-report@1` path SHALL accept the block runner's step and journal ids as plan step ids and evidence ids. The report SHALL include the block id and resolved version for each block-backed step, the failing sub-step for a failure, and every block-to-exploratory deviation. The report SHALL additionally carry `blocksUsed`, `blocksCreated` and `blocksAdjusted` as *claims* — the block and its version, plus the route step — which the engine verifies against the run's own recorded proofs; the proof itself is never part of the report, because a tester-written proof would be an assertion rather than a record. It SHALL also carry `unblockedSteps` naming every plan route step that ended without a block and the reason. The engine SHALL refuse a report that omits an unblocked step's reason, that names an unblocked step the plan does not contain, that claims a created or adjusted block whose draft holds no passed proof of that version and digest in this run, or that names a used block that is not the plan's block for that route step. A report that cites a step id or evidence id not produced by the runner or the exploratory tools SHALL be refused by the existing engine validation.

#### Scenario: Report includes block versions
- **WHEN** a block-backed step passes and the report cites its journal entry
- **THEN** the report SHALL name the block id and version beside the reproduction step

#### Scenario: Report names a deviation
- **WHEN** a plan switches from a block step to an exploratory step
- **THEN** the report SHALL list the switch under what was not tested as planned and why

#### Scenario: Unexplained unblocked step is refused
- **WHEN** a plan route step with no block is absent from `unblockedSteps`
- **THEN** the engine SHALL refuse the report naming the route step

#### Scenario: Unproven created block is refused
- **WHEN** the report claims a created block whose draft has no passed proof in this run
- **THEN** the engine SHALL refuse the report naming the block

### Requirement: Engine-rendered, validated report
The engine SHALL refuse a `core.stage-report@1` output in which an expectation of the plan has no verdict, a `pass` or `fail` cites no evidence id, a `fail` has no severity, or a cited evidence or step id does not exist. For an accepted output it SHALL render `stage-report.md` in the workflow's evidence directory with: ticket summary and reference; stage, environment, access and per-application versions; the plan's expectations and knowledge concepts; findings per expectation with verdict, severity, expected and observed, evidence captions and video offsets; the step timeline as reproduction steps; a blocks section with every used, created and adjusted block and the unblocked step reasons; created data; proposed wiki updates; not tested. The blocks section SHALL show, per created or adjusted block, its id, version, the postcondition, the operation list and — for an adjustment — the difference against the version currently in the shared store, and it SHALL be read from the run's drafts at render time and be bounded (at most 8 blocks and 60 lines each). Every rendered value SHALL pass through the shared redactor.

#### Scenario: Pass without evidence refused
- **WHEN** the tester outputs `pass` for E2 with no evidence id
- **THEN** the engine SHALL refuse the output naming E2

#### Scenario: Report rendered
- **WHEN** the tester's output is accepted
- **THEN** `stage-report.md` SHALL exist with one findings entry per plan expectation and the journal as numbered reproduction steps

#### Scenario: Report shows the authored block diff
- **WHEN** the report lists one created and one adjusted block
- **THEN** `stage-report.md` SHALL show both blocks with their postcondition and operations, and the adjusted one with its difference from the approved version

### Requirement: Report review, follow-ups and close
`stage.review` SHALL present the report for developer review with line comments and SHALL offer approve (→ `core.completed`, promoting the drafts the report claims), approve-and-update-wiki (→ `core.wiki`, promoting them as well, offered only when the report has knowledge observations other than `confirmed`) and a follow-up comment (→ `stage.execute` with the comment, at most 3 rounds, keeping the drafts). A draft the report does not claim SHALL never be published. The review SHALL make each created or adjusted block and its recorded proof visible in the rendered report, and the approval label SHALL name how many blocks it promotes. Closing the workflow SHALL stop its browser sessions, release its stage lease and remove its drafts.

#### Scenario: Follow-up
- **WHEN** the developer submits a comment asking to also test the rejection path
- **THEN** the workflow SHALL return to `stage.execute` with the comment in the assignment and the drafts intact

#### Scenario: Approve without wiki work
- **WHEN** the developer approves the report
- **THEN** the workflow SHALL move to `core.completed` without a wiki step and the approved blocks SHALL be promoted before or at completion

#### Scenario: Review shows the authored blocks
- **WHEN** the report lists one created block
- **THEN** the review SHALL show that block's postcondition, operations and proof and the approval SHALL be labelled with the number of blocks it promotes

### Requirement: Block failures return to the plan owner before the report
When a block fails, `stage.execute` SHALL return to the stage workflow with a structured block failure rather than silently continuing. The tester SHALL either record the failure against the expectation, adjust the failing draft and run it again inside the same run, request a plan revision, or complete the report with a `fail` or `blocked` verdict. The workflow SHALL NOT auto-promote a block fix or auto-approve a revised plan.

#### Scenario: Block failure is reported
- **WHEN** `fillCustomerAddress` fails its postcondition
- **THEN** the tester SHALL record the failure against the mapped expectation with the block id, version and evidence ids

#### Scenario: Revised plan needs re-approval
- **WHEN** the plan owner changes a block argument in response to a failure
- **THEN** the revised plan SHALL pass through plan review again before execution

#### Scenario: Draft is fixed and re-run inside the run
- **WHEN** an authored draft fails its own postcondition
- **THEN** the tester SHALL be able to save a corrected version of that draft and run it again without a plan revision, and only the newest proof SHALL be claimed in the report
