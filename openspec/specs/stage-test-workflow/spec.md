# stage-test-workflow Specification

## Purpose
TBD - created by archiving change add-stage-test-workflow. Update Purpose after archive.
## Requirements
### Requirement: Stage-test workflow family
The system SHALL register a built-in `stage-test` workflow family on the application-owned non-repository target with steps `stage.plan`, `stage.plan-review`, `stage.replay`, `stage.execute`, `stage.review`, `core.wiki`, `core.wiki-approval`, `core.completed` and `core.closed`. A start SHALL require a task (the ticket text) and a `stage` that is in the stage allow-list; it MAY carry a ticket reference and a read-only repository context. A start naming an unknown or excluded stage SHALL be refused with `stage-not-configured` before any workflow record is written. The stage SHALL be stored in the workflow metadata and SHALL NOT change for the workflow's life. The family SHALL require no branch and no worktree and SHALL never deliver code. `stage.replay` SHALL be an optional route between plan approval and execution; it SHALL be entered only when the approved plan names a replay-eligible flow, and it SHALL fall through to `stage.execute` when no replay flow is selected or the flow is not eligible.

#### Scenario: Start from the CLI
- **WHEN** the developer runs `workflow start --workflow stage-test --stage grid-int --task "<ticket text>"`
- **THEN** a `stage-test` workflow SHALL start at `stage.plan` with metadata `stage: grid-int` and no branch or worktree

#### Scenario: Unknown stage
- **WHEN** the developer starts a stage test with `--stage nope`
- **THEN** the start SHALL be refused with `stage-not-configured` and no workflow SHALL exist

#### Scenario: Replay route
- **WHEN** an approved plan names a replay-eligible flow and no approval is pending
- **THEN** the workflow SHALL enter `stage.replay` before `stage.execute`

### Requirement: The test plan and its engine-owned gate
`stage.plan` SHALL run the `stage-planner` role, which SHALL output a `core.stage-test-plan@1` document: ticket summary, expectations (id, statement, source `ticket` or `wiki`, priority), the knowledge concepts used with trust tier and staleness, the route (ordered steps with application, role, action, expected result and values to capture), asynchronous waits, whether it creates data and which, what will not be tested and why. When the stage's `planApproval` is `always`, or `when-writing` and the plan creates data on a `writable` stage, the engine SHALL route the completed plan to `stage.plan-review`; otherwise directly to `stage.execute`. `stage.plan-review` SHALL offer approve (→ `stage.execute`) and comments (→ `stage.plan`, at most 3 rounds).

#### Scenario: Writing plan stops for approval
- **WHEN** the stage's `planApproval` is `when-writing`, the stage is writable and the plan declares data creation
- **THEN** the workflow SHALL wait at `stage.plan-review`

#### Scenario: Read-only plan runs directly
- **WHEN** the plan declares no data creation and `planApproval` is `when-writing`
- **THEN** the workflow SHALL continue to `stage.execute` without a developer gate

### Requirement: Execution stays on the pinned stage
`stage.execute` SHALL run the `stage-tester` role with the approved plan and the stage description in its assignment. In a `stage-test` workflow the browser routes SHALL refuse a raw `url` and an app endpoint open with `stage-test-browsing-restricted` and SHALL refuse opening any stage other than the pinned one with `stage-mismatch`. The tester SHALL record steps through the step journal and SHALL complete with a `core.stage-report@1` output: per expectation a verdict of `pass`, `fail`, `blocked` or `inconclusive`, a severity for `fail`, expected and observed text, step ids and evidence ids; created data with cleanup hints; knowledge observations; what was not tested and why. An unreachable stage or a failed login SHALL yield `blocked` verdicts with the reason, not a failed run.

#### Scenario: Raw URL refused
- **WHEN** the tester calls `browser_open({ url: "https://example.org" })`
- **THEN** the call SHALL be refused with `stage-test-browsing-restricted`

#### Scenario: Login blocked by MFA
- **WHEN** `stage_login` answers `login-mfa-required` for the installer role
- **THEN** the expectations that need the installer SHALL be reported `blocked` with that reason and the run SHALL complete

### Requirement: Engine-rendered, validated report
The engine SHALL refuse a `core.stage-report@1` output in which an expectation of the plan has no verdict, a `pass` or `fail` cites no evidence id, a `fail` has no severity, or a cited evidence or step id does not exist. For an accepted output it SHALL render `stage-report.md` in the workflow's evidence directory with: ticket summary and reference; stage, environment, access and per-application versions; the plan's expectations and knowledge concepts; findings per expectation with verdict, severity, expected and observed, evidence captions and video offsets; the step timeline as reproduction steps; created data; proposed wiki updates; not tested. Every rendered value SHALL pass through the shared redactor.

#### Scenario: Pass without evidence refused
- **WHEN** the tester outputs `pass` for E2 with no evidence id
- **THEN** the engine SHALL refuse the output naming E2

#### Scenario: Report rendered
- **WHEN** the tester's output is accepted
- **THEN** `stage-report.md` SHALL exist with one findings entry per plan expectation and the journal as numbered reproduction steps

### Requirement: Report review, follow-ups and close
`stage.review` SHALL present the report for developer review with line comments and SHALL offer approve (→ `core.completed`), approve-and-update-wiki (→ `core.wiki`, offered only when the report has knowledge observations other than `confirmed`) and a follow-up comment (→ `stage.execute` with the comment, at most 3 rounds). Closing the workflow SHALL stop its browser sessions and release its stage lease.

#### Scenario: Follow-up
- **WHEN** the developer submits a comment asking to also test the rejection path
- **THEN** the workflow SHALL return to `stage.execute` with the comment in the assignment

#### Scenario: Approve without wiki work
- **WHEN** the developer approves the report
- **THEN** the workflow SHALL move to `core.completed` without a wiki step

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

### Requirement: Replay route preserves approval and pinned-stage rules
`stage.replay` SHALL run only after the approved plan and stage pin are recorded, SHALL not start when a plan approval is pending, and SHALL apply the same pinned-stage, application and role restrictions as `stage.execute`. A replay SHALL NOT be used to test another stage, a raw URL or an application outside the plan. A replay failure SHALL return to `stage.execute` with the heal packet; it SHALL not bypass the tester or the report validation.

#### Scenario: Approval still required
- **WHEN** a plan creates data on a writable stage and the stage's plan approval policy requires review
- **THEN** `stage.replay` SHALL not start until the plan is approved

#### Scenario: Different stage refused
- **WHEN** the workflow's pinned stage is `grid-int` and the flow manifest only allows `grid-uat`
- **THEN** `stage.replay` SHALL refuse the flow and the workflow SHALL use `stage.execute`

### Requirement: Replay coverage and inputs are declared in the existing plan
The `core.stage-test-plan@1` contract SHALL gain optional top-level `flowId` and `inputs` fields and an optional `expectationIds` array on each route step. These additions SHALL be backward-compatible and SHALL NOT introduce a new plan contract version; a plan without them SHALL remain valid for exploratory execution. The planner SHALL set `flowId` and bind route arguments to plan inputs with `{{ inputs.<name> }}` when it selects a saved flow. The planner SHALL map every route step to the expectations it verifies; a plan intended for replay SHALL cover every expectation with at least one block-backed route step. The plan review SHALL show the flow id, the approved input values, the derived input schema and the coverage. A plan with an expectation that no route step covers SHALL remain executable exploratorily but SHALL NOT be replay-eligible.

#### Scenario: Covered plan
- **WHEN** every expectation appears in at least one route step's `expectationIds` and every route step binds a block
- **THEN** the plan SHALL be eligible for deterministic replay report mapping

#### Scenario: Uncovered expectation
- **WHEN** an expectation has no route step mapping
- **THEN** the plan SHALL still be valid for `stage.execute` but SHALL be marked not replay-eligible

#### Scenario: Existing plan remains valid
- **WHEN** a stage plan has no `flowId`, `inputs` or `expectationIds`
- **THEN** the existing `core.stage-test-plan@1` decoder SHALL accept it unchanged and replay SHALL not be selected

### Requirement: Replay inputs belong to an approved plan revision
A replay SHALL execute with the input values recorded in the approved plan revision. Changing only those values SHALL require a new plan revision and approval, but SHALL NOT change the route hash, regenerate the spec or require a new flow manifest. `stage_replay` SHALL refuse an input set that does not match the approved revision with `flow-inputs-unapproved`; it SHALL NOT silently substitute environment values or defaults. A dry run MAY validate proposed values against the flow input schema and SHALL report that they are not approved.

#### Scenario: Same flow, new values
- **WHEN** the same flow is approved again with a different customer id
- **THEN** the workflow SHALL use the same spec and route hash, a new plan revision and a new `inputsHash`

#### Scenario: Unapproved override
- **WHEN** `stage_replay` receives inputs that differ from the approved plan revision
- **THEN** the tool SHALL refuse with `flow-inputs-unapproved` and SHALL not start the replay

#### Scenario: Dry-run validation
- **WHEN** a planner dry-runs a proposed input set against the flow input schema
- **THEN** the workflow SHALL return schema issues without starting a browser and SHALL mark the values as unapproved

### Requirement: Replay success produces the normal validated report
When `stage.replay` succeeds and covers every expectation, the engine SHALL map the replay result to a `core.stage-report@1` and pass it through the existing report validation, citation checks, redaction and render effect. A replay result that is incomplete, cites unknown evidence, or leaves an expectation without a verdict SHALL be refused exactly as a tester-authored report would be. The workflow SHALL record that the report came from replay, the flow id, the plan revision, the `inputsHash` and the block versions.

#### Scenario: Replay report accepted
- **WHEN** a replay covers all expectations and carries valid journal and evidence ids
- **THEN** the engine SHALL render `stage-report.md` and move to `stage.review`

#### Scenario: Invalid replay report refused
- **WHEN** a replay report cites an evidence id that is not attached to the workflow
- **THEN** the engine SHALL refuse the output and route to the tester or a defined failure state rather than rendering it

### Requirement: Replay failure returns to the tester with bounded evidence
A failed `stage.replay` SHALL transition to `stage.execute` with the heal packet, the failing flow id, route step, block id/version and the evidence ids. The tester SHALL use the packet to diagnose or report the failure and SHALL NOT be asked to re-derive the whole page from scratch. The stage run SHALL preserve the failed replay result and the eventual tester report as separate evidence.

#### Scenario: Failure routes to tester
- **WHEN** a replay step fails
- **THEN** `stage.execute` SHALL receive the heal packet and the failed replay result before it starts

#### Scenario: Tester reports failure
- **WHEN** the tester cannot resolve the failure within the approved route
- **THEN** it SHALL record a `fail` or `blocked` verdict with the replay evidence ids and complete the report

### Requirement: A replay flow is never silently substituted for the approved route
The planner and executor SHALL show whether a step is executed by replay, by a block plan, or exploratorily. A replay that covers only part of the plan, or whose block sequence differs from the approved route, SHALL be refused rather than treated as an equivalent route. Any route change SHALL go through plan review again before replay or execution. An input-only change SHALL also go through plan review as a new revision but SHALL NOT require spec regeneration.

#### Scenario: Partial flow refused
- **WHEN** a plan has three route steps and the proposed flow covers two
- **THEN** `stage.replay` SHALL refuse the flow and the workflow SHALL not claim the third step ran

#### Scenario: Route change re-approval
- **WHEN** the developer changes a route step, a block argument placeholder or an expectation mapping
- **THEN** the route hash SHALL change and replay SHALL require a regenerated flow and a new approval

#### Scenario: Input-only change reuses the flow
- **WHEN** the developer changes only the plan's input values
- **THEN** the flow id, route hash and spec SHALL remain unchanged and the new values SHALL require a new plan approval before replay

