# Spec Delta

## Purpose

Bound the durable dialogue tools' wait and let an aborted tool call end the CLI
it spawned.

## MODIFIED Requirements

### Requirement: Workflow dialogue tools
Every durable run SHALL offer `developer_question` and `agent_ask` with the same parameters, descriptions and validation as the pi workflow extension, executing the workflow question and ask CLI commands with the run's environment. Each tool SHALL bound its own wait to the agent grace window, SHALL forward the tool call's abort signal to the spawned CLI process, and SHALL return the resulting record to the model whether it is answered, pending, cancelled, or expired. These tools SHALL NOT be replayed after an interruption.

#### Scenario: Developer question from a durable run
- **WHEN** a durable agent calls `developer_question` with a questions array
- **THEN** the workflow question command SHALL be invoked for that run
- **AND** the developer's answer SHALL be returned as the tool result when it arrives within the agent grace window
- **AND** the pending records SHALL be returned as the tool result otherwise

#### Scenario: Question wait expires with no answer
- **WHEN** the agent grace window elapses with the question still pending
- **THEN** the tool SHALL return the pending record with the question identity and status
- **AND** the tool SHALL NOT expire or cancel the durable question

#### Scenario: Aborted question call kills the spawned CLI
- **WHEN** the tool call is aborted while the spawned CLI process is waiting
- **THEN** the tool SHALL abort the spawn so no question process keeps polling
- **AND** the durable question SHALL remain pending for a later answer

#### Scenario: Interrupted question
- **WHEN** the host dies while `developer_question` waits and the host resumes
- **THEN** the model SHALL receive an interrupted result rather than a second question being raised
