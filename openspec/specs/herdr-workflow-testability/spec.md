# herdr-workflow-testability Specification

## Purpose
TBD - created by archiving change architecture-refactoring-and-implementation-of-proper-testing. Update Purpose after archive.

## Requirements

### Requirement: Behaviour-preserving CLI contract
The system SHALL lock new breaking command/view contracts and SHALL reject accidental reintroduction of legacy phase mutation verbs.

#### Scenario: Subcommand surface unchanged
- **WHEN** characterization suite inspects workflow CLI
- **THEN** it SHALL expose `start`, `status`, `action`, `handoff`, `repair`, `projects`, `config`, and `agent-extension`
- **AND** it SHALL not expose removed role/phase transition verbs

#### Scenario: state.json schema unchanged
- **WHEN** status is requested for fixture workflow
- **THEN** golden replacement contract SHALL include revision, definition pin, current step, runs, routing, health, and available actions
- **AND** it SHALL intentionally not preserve raw legacy `state.json` fields

#### Scenario: Executable stays on PATH
- **WHEN** package is installed
- **THEN** `agentic-coding` SHALL remain executable on PATH
- **AND** managed prompts SHALL invoke its generic workflow handoff directly

### Requirement: Pure logic separated from side effects
Workflow graph validation, command authorization decisions, state reducers, resulting-state validation, routing resolution, and repair planning SHALL be pure and testable without subprocess, filesystem, network, database, or clock.

#### Scenario: Transition logic is pure
- **WHEN** reducer receives validated snapshot and command
- **THEN** it SHALL return deterministic next snapshot and effect intents
- **AND** it SHALL not execute effect

#### Scenario: Effects are behind injectable seams
- **WHEN** command runtime persists state or executes SQLite, Herdr, Git, filesystem, clock, runtime adapter, or trace export work
- **THEN** tests SHALL substitute fakes or temporary stores
- **AND** pure modules SHALL not import production effects

### Requirement: Each phase is tested in isolation
Every registered built-in step, legal outcome, validation failure, retry bound, developer gate, and repair target SHALL have isolated automated coverage.

#### Scenario: Apply phase gate is tested
- **WHEN** planning run completes with valid and invalid OpenSpec artifacts
- **THEN** tests SHALL assert valid output opens approval action
- **AND** invalid output leaves revision/current step unchanged

#### Scenario: Verification outcomes are tested
- **WHEN** selected verifiers report concurrently
- **THEN** tests SHALL cover missing, duplicate, all-pass, critical-fail, test-run, fix-loop, and attempt-limit outcomes
- **AND** each committed run result SHALL be retained exactly once

#### Scenario: Invalid transitions are rejected in tests
- **WHEN** command targets unavailable action, stale revision, invalid artifact, expired capability, or illegal outcome
- **THEN** test SHALL assert no snapshot/event/outbox mutation

### Requirement: Each workflow type is tested end to end
Each registered built-in workflow definition SHALL be driven through complete command, run, gate, and effect lifecycle using fake adapters and real temporary Git repository.

#### Scenario: Standard workflow runs to completion
- **WHEN** test drives planning, approval, implementation, triage, verification, developer review, archive, and delivery
- **THEN** visited step sequence SHALL match pinned standard definition
- **AND** workflow SHALL terminate completed

#### Scenario: Direct-apply and no-openspec workflows run to completion
- **WHEN** valid pre-authored artifacts start direct-apply and runs complete
- **THEN** no planning run SHALL launch
- **AND** sequence SHALL include archive before delivery

#### Scenario: No-OpenSpec completes
- **WHEN** task starts no-OpenSpec flow and runs complete
- **THEN** no planning/OpenSpec-verifier/archive run SHALL launch
- **AND** approved verification SHALL proceed to delivery and completion

### Requirement: Tests are runnable via a single command
Repository SHALL provide one documented command that installs locked dependencies and runs complete Bun test suite with non-zero failure exit.

#### Scenario: Suite runs with stdlib unittest
- **WHEN** workflow test script executes in clean checkout with supported Bun
- **THEN** it SHALL install frozen dependencies and run unit, migration, adapter, persistence, command, and end-to-end tests
- **AND** any failure SHALL return non-zero

### Requirement: Crash and concurrency boundaries are tested
Tests SHALL inject failure before/after transaction commit and during every external effect, plus concurrent commands against same revision.

#### Scenario: Process fails after commit
- **WHEN** test commits command then interrupts effect runner
- **THEN** restart SHALL resume one pending idempotent effect
- **AND** state/event SHALL not duplicate

#### Scenario: Concurrent handoffs race
- **WHEN** multiple processes submit final parallel results concurrently
- **THEN** all distinct valid results SHALL persist
- **AND** successor effect SHALL enqueue once

### Requirement: Legacy migration is tested
Migration tests SHALL cover every recognized legacy workflow type and operational state, equivalent mirrors, conflicting mirrors, malformed rows, and active-agent reissue.

#### Scenario: Valid legacy row migrates
- **WHEN** fixture loads recognized legacy state
- **THEN** resulting snapshot SHALL satisfy current schema and pinned definition
- **AND** migration audit event SHALL identify source version

#### Scenario: Ambiguous row fails closed
- **WHEN** fixture mirrors conflict or phase evidence is inconsistent
- **THEN** workflow view SHALL require repair
- **AND** no agent/effect SHALL launch

### Requirement: Runtime adapters share contract tests
Pi, OpenCode, and OpenCode V2 adapters SHALL pass same launch/prompt/status/stop and assignment semantics suite, with runtime-specific argument assertions and conditional live smoke tests.

#### Scenario: Adapter contract suite runs
- **WHEN** fake Herdr drives each adapter
- **THEN** each SHALL use managed agent start/get/prompt sequence and same assignment payload
- **AND** missing executable/capability SHALL fail preflight

#### Scenario: Installed runtime smoke test runs
- **WHEN** corresponding executable and test credentials are explicitly available
- **THEN** opt-in smoke SHALL verify detection, prompt delivery, generic handoff, status observation, and baseline telemetry
- **AND** absent runtime SHALL be reported skipped rather than auto-installed
