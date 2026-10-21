## MODIFIED Requirements

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

## ADDED Requirements

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
