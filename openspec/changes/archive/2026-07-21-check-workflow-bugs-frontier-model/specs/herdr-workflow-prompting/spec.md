## ADDED Requirements

### Requirement: Role prompts are submitted atomically
The workflow SHALL submit a role agent's prompt so that the prompt text and its Enter/submit are delivered together, and SHALL only submit once the target agent's TUI is ready to accept input.

#### Scenario: Prompt text and Enter are delivered together
- **GIVEN** a role agent whose pane has been created and the agent moved into it
- **WHEN** the workflow submits the role's prompt via `prompt_role`
- **THEN** it SHALL deliver the prompt text and its submit together as a single atomic action (`herdr pane run`)
- **AND** it SHALL NOT rely on a separate `send-text` followed by a separate `send-keys "enter"`, which can leave the prompt prefilled but unsent

#### Scenario: Wait for readiness before submitting
- **GIVEN** a freshly launched role agent
- **WHEN** the workflow prepares to submit its prompt
- **THEN** it SHALL wait for the agent to reach `idle` status (bounded by a timeout) before submitting
- **AND** on timeout it SHALL record `prompt_wait_timeout` telemetry and still attempt the submit

#### Scenario: Prompt submission is verified and retried
- **GIVEN** a submitted prompt whose delivery is not acknowledged (the agent's state-change sequence does not advance within the deadline)
- **WHEN** the workflow retries
- **THEN** it SHALL interrupt the pane (`ctrl+c`) and re-submit the prompt atomically via `herdr pane run`
- **AND** if the retry is still not acknowledged it SHALL raise an error rather than silently leaving the agent idle
