# Spec Delta

## Purpose

Workflow agents delegate investigations to the debug role asynchronously,
receive the report in their conversation, and the developer sees every request
read-only.

## ADDED Requirements

### Requirement: Asynchronous debug requests

Every durable run except debug runs SHALL be offered `debug_request`, `debug_result`, `debug_wait` and `debug_cancel`. A request SHALL start a debug run in the caller's worktree with the caller workflow's environment owner and return its id without waiting for completion.

#### Scenario: Request while implementing

- **WHEN** an implementation agent calls `debug_request` with a goal
- **THEN** the tool SHALL return a request id immediately and a debug run SHALL start in the same worktree

#### Scenario: Recursion

- **WHEN** a debug run's tool list is built
- **THEN** it SHALL NOT contain `debug_request`

### Requirement: Results are delivered into the caller conversation

When a debug run completes, the engine SHALL deliver the report summary, report path, evidence ids and changed files into the caller's conversation as a follow-up exactly once; when the caller run has ended, the report SHALL remain available through `debug_result` and the dashboard.

#### Scenario: Effect retried after delivery

- **WHEN** the delivery effect is retried after a successful submit
- **THEN** the caller SHALL receive the report only once

### Requirement: Limits and handoff guard

A caller run SHALL have at most one open request and a workflow at most two; a caller SHALL NOT hand off while it has open requests unless it cancels them.

#### Scenario: Handoff with open request

- **WHEN** a caller hands off while its request is running
- **THEN** the handoff SHALL be refused naming the open request id

### Requirement: Developer view is read-only

The dashboard SHALL list the workflow's debug requests with caller role, goal, status and duration and SHALL show each report and its evidence without offering any approval or mutating action.

#### Scenario: Developer opens a request

- **WHEN** the developer selects a completed request
- **THEN** the report and its evidence SHALL be shown and no action other than navigation or opening files SHALL be available
