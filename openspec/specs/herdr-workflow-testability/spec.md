# herdr-workflow-testability Specification

## Purpose
TBD - created by archiving change architecture-refactoring-and-implementation-of-proper-testing. Update Purpose after archive.
## Requirements
### Requirement: Behaviour-preserving CLI contract

The refactor SHALL preserve the external `herdr-workflow` command-line contract
so existing callers (the dashboard and scripts) keep working unchanged.

#### Scenario: Subcommand surface unchanged

- **GIVEN** the refactored `herdr-workflow` entrypoint
- **WHEN** the argument parser is constructed
- **THEN** it SHALL expose every subcommand present before the refactor
  (`projects`, `config`, `start`, `planner`, `apply`, `verify`, `recover`,
  `apply-recovery`, `dispatch-verifiers`, `archive`, `close`, `status`,
  `check-timeout`, `git-operations`, `phase`, `override-phase`,
  `preflight-archive`, `set-return`, `verification-result`, `message`, `plugin`)
- **AND** each subcommand SHALL keep the same required flags and positional
  arguments it had before

#### Scenario: state.json schema unchanged

- **GIVEN** a workflow started with the refactored code
- **WHEN** `state.json` is written
- **THEN** it SHALL contain the same field names and value shapes the dashboard
  reads as `WorkflowState` (including `changeId`, `phase`, `repository`,
  `worktree`, `branch`, `workspace`, `workflowModules`, `workflowType`, `panes`,
  `tabs`, `verificationRound`)
- **AND** no field SHALL be renamed or removed relative to the pre-refactor
  schema

#### Scenario: Executable stays on PATH

- **GIVEN** the package decomposition
- **WHEN** the code is installed via the existing stow flow
- **THEN** `herdr-workflow` SHALL remain an executable file resolvable on `PATH`
- **AND** invoking it SHALL dispatch into the `herdr_workflow` package

### Requirement: Pure logic separated from side effects

Decision logic SHALL be implemented as pure functions with no subprocess,
filesystem, network, or clock access, so it can be unit-tested directly.

#### Scenario: Transition logic is pure

- **GIVEN** a workflow state dictionary
- **WHEN** `allowed_transitions` is called
- **THEN** it SHALL compute allowed phase transitions from the state's
  `workflowModules` alone
- **AND** it SHALL NOT invoke `herdr`, `git`, the network, or read the clock

#### Scenario: Effects are behind injectable seams

- **GIVEN** the command orchestration layer
- **WHEN** a `cmd_*` function needs to call `herdr`, run `git`, read the current
  time, or export a trace
- **THEN** it SHALL do so through an injected effects context rather than calling
  the subprocess, `time`, or `urllib` modules inline
- **AND** tests SHALL be able to substitute fake implementations of those seams

### Requirement: Direct tab and pane agent launch

Role agents SHALL be launched by creating a tab and running pi in its pane rather
than via `herdr agent start`, while preserving agent status detection and the
stored pane/tab state.

#### Scenario: Launch creates a tab and runs pi

- **GIVEN** a workflow that needs to launch a role agent
- **WHEN** the launch effect runs
- **THEN** it SHALL create a tab in the workflow's workspace (carrying the role
  environment) and obtain that tab's root pane
- **AND** it SHALL start the agent by running pi in that pane via `herdr pane run`
- **AND** it SHALL record the pane id under `panes[role]` and the tab id under
  `tabs[role]` in state
- **AND** it SHALL NOT call `herdr agent start` and SHALL NOT perform a
  `pane move --new-tab` relocation

#### Scenario: Status detection survives the new launch path

- **GIVEN** a role agent launched via tab creation and `pane run`
- **WHEN** the workflow queries agent status or waits for readiness
- **THEN** it SHALL address the agent by its stored pane id
- **AND** `agent get` / `wait agent-status` SHALL continue to work because the pi
  integration reports status into the pane
- **AND** when no status is reported the existing prompt-delivery fallback SHALL
  still apply

#### Scenario: Launch sequence is asserted in tests

- **GIVEN** a fake herdr effect
- **WHEN** a role agent is launched during a test
- **THEN** the test SHALL assert the recorded calls are tab creation followed by
  `pane run`
- **AND** the test SHALL assert no `agent start` or `pane move` call was recorded

### Requirement: Prompt submission is verified and executed

The workflow SHALL confirm that a role agent's prompt was actually submitted
(not merely prefilled) and SHALL issue an explicit submit key when the primary
submission does not take effect.

#### Scenario: Prompt submitted on first attempt

- **GIVEN** a role agent that is idle and ready for input
- **WHEN** the workflow submits its prompt via `herdr pane run`
- **AND** the agent's state-change sequence advances within the verification
  window
- **THEN** the submission SHALL be treated as executed
- **AND** the workflow SHALL NOT send an additional submit key

#### Scenario: Prefilled prompt is nudged with an explicit Enter

- **GIVEN** a submitted prompt whose text is prefilled but whose state-change
  sequence does not advance within the verification window
- **WHEN** the workflow detects the non-advancing sequence
- **THEN** it SHALL send an explicit submit key to the pane (`send-keys enter`)
- **AND** it SHALL re-verify that the state-change sequence advances
- **AND** on advance it SHALL treat the prompt as executed without re-typing it

#### Scenario: Exhausted submission raises rather than stalling

- **GIVEN** a prompt whose sequence never advances after `pane run` and the
  Enter nudge across the bounded retries
- **WHEN** the retries are exhausted
- **THEN** the workflow SHALL raise an unacknowledged-prompt error
- **AND** it SHALL remove the role's trace-handoff file
- **AND** it SHALL NOT leave the agent silently idle as if the prompt succeeded

#### Scenario: Missing status reporting keeps assume-delivered behaviour

- **GIVEN** an environment where the agent reports no state-change sequence
- **WHEN** the workflow submits the prompt via `herdr pane run`
- **THEN** it SHALL treat the prompt as delivered without requiring sequence
  advancement

### Requirement: Each phase is tested in isolation

Every workflow phase transition SHALL have an automated test that drives its
command against fake effects and asserts the resulting state.

#### Scenario: Apply phase gate is tested

- **GIVEN** a test that constructs a workflow state in `proposed` phase and a
  fake effects context
- **WHEN** the apply command runs with all required plan artifacts present
- **THEN** the test SHALL assert the phase becomes `apply` and the worker agent
  was started
- **AND** a separate test SHALL assert that a failing plan-quality gate raises an
  error and does not advance the phase

#### Scenario: Verification outcomes are tested

- **GIVEN** a workflow state in `verify` phase with fake verifier reports
- **WHEN** verifier results are recorded
- **THEN** tests SHALL cover the all-pass path (advancing to the test verifier
  then `developer-review`), the any-fail path (advancing to `fix`), and the
  round-limit path (advancing to `paused`)

#### Scenario: Invalid transitions are rejected in tests

- **GIVEN** a workflow state in a phase from which a target phase is not allowed
- **WHEN** the phase command is invoked with that target
- **THEN** the test SHALL assert the command raises an error and leaves the phase
  unchanged

### Requirement: Each workflow type is tested end to end

Each entry in `WORKFLOW_TYPES` SHALL have an automated test that drives a full
run through its module chain using fake effects.

#### Scenario: Standard workflow runs to completion

- **GIVEN** a `standard` workflow started against a temporary repository with
  fake effects
- **WHEN** the test drives it through explore, proposed, apply, verify,
  developer-review, archive, and git-operations
- **THEN** the phase sequence SHALL match the modules in
  `WORKFLOW_TYPES["standard"]`
- **AND** the workflow SHALL terminate in the `completed` phase

#### Scenario: Direct-apply and no-openspec workflows run to completion

- **GIVEN** a `direct-apply` workflow and a `no-openspec` workflow each started
  with fake effects
- **WHEN** each is driven through its module chain
- **THEN** each SHALL start in the `apply` phase without a planner
- **AND** each SHALL terminate in the `completed` phase following its own
  `WORKFLOW_TYPES` module sequence

### Requirement: Tests are runnable via a single command

The test suite SHALL be runnable with one command using only the standard
library, with no new runtime dependency.

#### Scenario: Suite runs with stdlib unittest

- **WHEN** the workflow test script is executed
- **THEN** it SHALL run the full suite via `python3 -m unittest`
- **AND** it SHALL exit non-zero if any test fails
- **AND** it SHALL require no third-party test framework

