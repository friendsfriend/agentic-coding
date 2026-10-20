## ADDED Requirements

### Requirement: Stage-test workflow family
The system SHALL register a built-in `stage-test` workflow family on the application-owned non-repository target with steps `stage.plan`, `stage.plan-review`, `stage.execute`, `stage.review`, `core.wiki`, `core.wiki-approval`, `core.completed` and `core.closed`. A start SHALL require a task (the ticket text) and a `stage` that is in the stage allow-list; it MAY carry a ticket reference and a read-only repository context. A start naming an unknown or excluded stage SHALL be refused with `stage-not-configured` before any workflow record is written. The stage SHALL be stored in the workflow metadata and SHALL NOT change for the workflow's life. The family SHALL require no branch and no worktree and SHALL never deliver code.

#### Scenario: Start from the CLI
- **WHEN** the developer runs `workflow start --workflow stage-test --stage grid-int --task "<ticket text>"`
- **THEN** a `stage-test` workflow SHALL start at `stage.plan` with metadata `stage: grid-int` and no branch or worktree

#### Scenario: Unknown stage
- **WHEN** the developer starts a stage test with `--stage nope`
- **THEN** the start SHALL be refused with `stage-not-configured` and no workflow SHALL exist

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
