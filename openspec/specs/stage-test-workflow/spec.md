# stage-test-workflow Specification

## Purpose
TBD - created by archiving change add-stage-test-workflow. Update Purpose after archive.
## Requirements
### Requirement: Stage-test workflow family
The system SHALL register a built-in `stage-test` workflow family on the application-owned
non-repository target with steps `core.route-stage-execute`, `stage.execute`, `stage.review`,
`core.wiki`, `core.wiki-approval`, `core.completed` and `core.closed`. A start SHALL require a task
(the ticket text) and a `stage` that is in the stage allow-list; it MAY carry a ticket reference and
a read-only repository context. A start naming an unknown or excluded stage SHALL be refused with
`stage-not-configured` before any workflow record is written. The stage SHALL be stored in the
workflow metadata and SHALL NOT change for the workflow's life. The family SHALL require no branch
and no worktree and SHALL never deliver code. The family SHALL have exactly one agent role,
`stage-tester`, and no plan step, no plan-review step and no plan-approval gate. The graph change
SHALL be registered as a new definition version tier, and definitions registered before it SHALL
keep their own graph, digest and step list so a workflow pinned to them still runs and completes.

#### Scenario: Start from the CLI
- **WHEN** the developer runs `workflow start --workflow stage-test --stage grid-int --task "<ticket text>"`
- **THEN** a `stage-test` workflow SHALL start at `core.route-stage-execute` with metadata
  `stage: grid-int` and no branch or worktree

#### Scenario: Unknown stage
- **WHEN** the developer starts a stage test with `--stage nope`
- **THEN** the start SHALL be refused with `stage-not-configured` and no workflow SHALL exist

#### Scenario: Pinned older graph still runs
- **WHEN** a workflow was started on an earlier `stage-test` definition version
- **THEN** it SHALL resolve its own graph, including its plan steps, and SHALL complete without a
  resolution error

### Requirement: Execution stays on the pinned stage
`stage.execute` SHALL run the `stage-tester` role with the ticket and the stage description in its
assignment. In a `stage-test` workflow the browser routes SHALL refuse a raw `url` and an app
endpoint open with `stage-test-browsing-restricted`, SHALL refuse opening any stage other than the
pinned one with `stage-mismatch`, and SHALL refuse an application or role the pinned stage does not
declare. The stage's `access` SHALL be the only write boundary: a `read-only` stage refuses every
state-changing request and a `writable` stage allows the tester to create and change test data it
needs. The tester SHALL record steps through the step journal and SHALL complete with a
`core.stage-report@1` output listing the expectations it chose to verify, each with a verdict of
`pass`, `fail`, `blocked` or `inconclusive`, a statement, a severity for `fail`, expected and
observed text, step ids and evidence ids; plus created data with cleanup hints, knowledge
observations, and what was not tested and why. An unreachable stage or a failed login SHALL yield
`blocked` verdicts with the reason, not a failed run.

#### Scenario: Raw URL refused
- **WHEN** the tester calls `browser_open({ url: "https://example.org" })`
- **THEN** the call SHALL be refused with `stage-test-browsing-restricted`

#### Scenario: Undeclared role refused
- **WHEN** the tester opens a stage application with a `stageRole` the pinned stage does not declare
  for that application
- **THEN** the call SHALL be refused with `stage-role-unknown`

#### Scenario: Tester defines the expectations
- **WHEN** the tester decides the ticket is verified by three checks
- **THEN** the report SHALL carry exactly those three expectations, each with its own statement and
  verdict, and the engine SHALL NOT require an expectation from any other source

#### Scenario: Login blocked by MFA
- **WHEN** `stage_login` answers `login-mfa-required` for the installer role
- **THEN** the expectations that need the installer SHALL be reported `blocked` with that reason and
  the run SHALL complete

### Requirement: Engine-rendered, validated report
The engine SHALL refuse a `core.stage-report@1` output in which a `pass` or `fail` cites no evidence
id, a `fail` has no severity, a cited evidence or step id does not exist, a declared application has
no version status, a knowledge observation is not backed by a stage journal step, or a claimed block
does not resolve in the registry this run executes. For an accepted output it SHALL render
`stage-report.md` in the workflow's evidence directory with: the ticket reference; stage,
environment, access and per-application versions; the tester's expectations with their statements;
findings per expectation with verdict, severity, expected and observed, evidence captions and video
offsets; the step timeline as reproduction steps; a blocks section with every used, created and
adjusted block; created data; proposed wiki updates; not tested. The blocks section SHALL show, per
created or adjusted block, its id, version, the postcondition, the operation list and — for an
adjustment — the difference against the version currently in the shared store, and it SHALL be read
from the run's drafts at render time and be bounded (at most 8 blocks and 60 lines each). Every
rendered value SHALL pass through the shared redactor.

#### Scenario: Pass without evidence refused
- **WHEN** the tester outputs `pass` for E2 with no evidence id
- **THEN** the engine SHALL refuse the output naming E2

#### Scenario: Report rendered
- **WHEN** the tester's output is accepted
- **THEN** `stage-report.md` SHALL exist with one findings entry per expectation the tester listed and
  the journal as numbered reproduction steps

#### Scenario: Missing application version refused
- **WHEN** the pinned stage declares two applications and the report carries one version status
- **THEN** the engine SHALL refuse the output naming the missing application

#### Scenario: Report shows the authored block diff
- **WHEN** the report lists one created and one adjusted block
- **THEN** `stage-report.md` SHALL show both blocks with their postcondition and operations, and the
  adjusted one with its difference from the approved version

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

### Requirement: Stage reports consume block execution results
The `core.stage-report@1` path SHALL accept the block runner's step and journal ids as step ids and
evidence ids. The report SHALL carry `blocksUsed`, `blocksCreated` and `blocksAdjusted` as *claims*:
the block, its version and — for a created or adjusted block — the digest `stage_block_save`
returned. The engine SHALL verify a created or adjusted claim against the run's own recorded proofs;
the proof itself is never part of the report, because a tester-written proof would be an assertion
rather than a record. The engine SHALL refuse a report that claims a created or adjusted block whose
draft holds no passed proof of that version and digest in this run, that cites a digest other than
the draft's current document, or that names a used block the run's registry cannot resolve at that
version. A report that cites a step id or evidence id not produced by the runner, the replay or the
exploratory tools SHALL be refused by the existing engine validation.

#### Scenario: Report includes block versions
- **WHEN** a block-backed step passes and the report cites its journal entry
- **THEN** the report SHALL name the block id and version beside the reproduction step

#### Scenario: Unproven created block is refused
- **WHEN** the report claims a created block whose draft has no passed proof in this run
- **THEN** the engine SHALL refuse the report naming the block

#### Scenario: Unknown used block is refused
- **WHEN** the report claims a used block whose id the run's registry does not resolve
- **THEN** the engine SHALL refuse the report naming the block

### Requirement: Stage execution runs the tester's own block plan
`stage.execute` SHALL run the `stage-tester` role without an approved route. The tester SHALL
compose one standalone block plan `{ planId?, flowId?, inputs?, steps }` itself and execute it with
`stage_run`, and it SHALL be free to explore with the browser tools before, between and after such
calls. A step's `args` SHALL be the tester's own values; there SHALL be no second argument source and
no notion of a step the tester is "not allowed" to run. The engine SHALL keep refusing a plan that
names an unknown block, an argument that does not match the block's parameter schema, a block scoped
to an application the pinned stage does not declare, a destructive block, a write block on a
read-only stage, and an argument that contains a configured secret value. A stage that the browser
routes refuse, a failed login or a failing block SHALL be reported as a blocked or failed verdict,
never as a failed run.

#### Scenario: One plan for the blocks the tester chose
- **WHEN** the tester has checked the catalog and decides to run `openCustomer` then
  `fillCustomerAddress`
- **THEN** it SHALL call `stage_run` once with those two steps and their own arguments and SHALL
  receive the per-step journal and evidence ids

#### Scenario: Exploration and blocks in one run
- **WHEN** the tester needs a page it has not driven before
- **THEN** it SHALL explore with the browser tools and MAY return to `stage_run` with a plan built
  from what it learned, without any approval in between

#### Scenario: Read-only stage refuses a write block
- **WHEN** the tester's plan names a `write` block on a `read-only` stage
- **THEN** `stage_run` SHALL refuse the plan before opening a browser and name the read-only stage

### Requirement: Block failures stay inside the tester's run
When a block fails, the tester SHALL keep working inside `stage.execute`: it SHALL either record the
failure against the expectation it belongs to, save a corrected draft and run it again, or explore
the step with the browser tools. The workflow SHALL NOT auto-promote a block, auto-repair a spec, or
invent a verdict. A draft that fails and is corrected SHALL be claimed only in its newest proven
form.

#### Scenario: Block failure is reported
- **WHEN** `fillCustomerAddress` fails its postcondition
- **THEN** the tester SHALL record the failure against the expectation with the block id, version
  and evidence ids and continue with the independent expectations

#### Scenario: Corrected draft inside the same run
- **WHEN** an authored draft fails its own postcondition
- **THEN** the tester SHALL be able to save a corrected version and run it again in the same run, and
  only the newest proof SHALL be claimable in the report

