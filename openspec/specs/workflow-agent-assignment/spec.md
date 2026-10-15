# workflow-agent-assignment Specification

## Purpose
Defines one agent-product-independent assignment and handoff protocol so every managed agent receives complete Markdown instructions as a message and can never mutate workflow lifecycle directly.
## Requirements
### Requirement: Skill-free instruction delivery
Managed workflow agents SHALL NOT load, invoke, or discover workflow skills; engine SHALL render trusted Markdown protocol and step instruction assets into the conversation's first assignment message for a step and role, and later rounds of that step and role SHALL carry the complete dynamic envelope without repeating those assets.

#### Scenario: Agent run starts
- **WHEN** adapter launches managed run
- **THEN** runtime arguments/configuration SHALL not reference workflow `SKILL.md` or skill invocation
- **AND** engine SHALL send rendered Markdown instructions and dynamic assignment as normal agent message

#### Scenario: Runtime has native skill support
- **WHEN** selected runtime can load skills automatically
- **THEN** workflow instruction delivery SHALL remain message-based
- **AND** workflow correctness SHALL NOT depend on runtime skill mechanism

#### Scenario: Persistent agent receives a later round
- **WHEN** an existing agent session is reused for a later generation of the same step and role
- **THEN** the prompt SHALL carry the complete dynamic envelope: fresh run ID, generation, inputs, permissions, required checks, output path and schema, allowed outcomes and handoff syntax
- **AND** SHALL NOT repeat the managed workflow protocol or the step instruction asset, which remain in the conversation from the first message
- **AND** SHALL name the workflow's pinned instruction asset copy as the recovery path for a session that no longer holds them (compaction or resume)
- **AND** the agent SHALL not need prior prompt context to determine its scope, checks or handoff

### Requirement: Complete assignment envelope
Each agent prompt SHALL identify protocol version, run, stable step and role, objective, interaction mode, scoped inputs, permissions, required checks, exact output path and schema, allowed outcomes, and generic handoff syntax. A `core.research` assignment SHALL additionally identify the user task, optional repository evidence boundary, persistent-session expectation, and the rule that research remains active until the developer dispatches an explicit wiki-request action or closure. A research `core.wiki` assignment SHALL identify the carried research context, centralized draft boundary, and pending developer approval.

#### Scenario: Persistent agent receives next run
- **WHEN** existing agent session is reused for later attempt or round
- **THEN** the next prompt SHALL include complete current assignment with fresh run ID, generation, output path, and capability
- **AND** its previous run capability SHALL be rejected
- **AND** the agent SHALL not need prior prompt context to determine scope or handoff

#### Scenario: Researcher receives complete context
- **WHEN** the `researcher` role is launched for `core.research`
- **THEN** the assignment identifies the research task, whether repository context is present, read-only repository permissions when applicable, runtime-neutral tool policy, follow-up behavior, and explicit user closure rule
- **AND** repository-context research is rejected unless the selected researcher profile provides an enforced read-only capability boundary

#### Scenario: Assignment cannot be rendered safely
- **WHEN** required instruction asset is missing, changed from pinned digest, oversized, or assignment data is invalid
- **THEN** launch SHALL fail before prompt delivery
- **AND** the run SHALL not be presented as working

### Requirement: Runtime-neutral handoff command
Every managed agent SHALL report only `complete`, `blocked`, or `failed` through one generic `agentic-coding workflow handoff` command whose workflow, role, run, capability, and run generation come from engine-provided environment. The researcher instructions SHALL prohibit all completion handoffs and direct the researcher to remain available until the developer explicitly dispatches `request-research-wiki` or `close-research`. A wiki agent's completion handoff SHALL enter developer approval.

#### Scenario: Agent completes assignment
- **WHEN** an agent writes required output and invokes handoff with `complete`
- **THEN** the agent SHALL provide only outcome and declared artifact
- **AND** the engine SHALL derive workflow and run identity without agent-supplied phase, role, change ID, or successor

#### Scenario: Researcher answers without handoff
- **WHEN** the researcher answers a question or follow-up while `core.research` is active
- **THEN** it SHALL not hand off `complete`
- **AND** the active research workflow SHALL remain available for another user prompt

#### Scenario: Agent is blocked
- **WHEN** an agent cannot continue without clarification or operator action
- **THEN** it SHALL hand off `blocked` with bounded message
- **AND** the step definition SHALL route the blocker to configured responder or dashboard without the agent choosing the recipient

#### Scenario: Agent fails assignment
- **WHEN** an agent encounters non-recoverable execution failure
- **THEN** it SHALL hand off `failed` with bounded diagnostic
- **AND** the step definition SHALL apply its pinned failure/retry policy without stopping the agent session
- **AND** a later same-role run SHALL re-prompt that session with fresh authority

### Requirement: Run capability authority
Each assignment SHALL carry single-use capability scoped to workflow, run, actor, run generation, issued revision, allowed outcomes, output location, and expiry; persisted authority SHALL not store reusable plaintext token.

#### Scenario: Valid capability is submitted
- **WHEN** active run handoff matches capability scope and revision
- **THEN** engine SHALL authorize handoff and consume capability only after output validation and successful transaction

#### Scenario: Capability is stale or forged
- **WHEN** handoff uses expired, consumed, repaired-away, wrong-run, wrong-actor, or invalid capability
- **THEN** engine SHALL reject it without state change
- **AND** attempt SHALL be audited without exposing secret

### Requirement: Agents do not choose lifecycle
Assignment protocol SHALL prohibit agents from naming target step, phase, next role, effect, or workflow closure and the engine SHALL ignore any such fields if present outside output schema. Only the registered reducer selects the wiki and approval successors; only the developer's revision-bound `close-research` action may directly close an active research workflow.

#### Scenario: Output requests phase change
- **WHEN** an agent artifact includes undeclared phase or successor field
- **THEN** output schema validation SHALL reject it or discard it as unknown according to schema
- **AND** the registered reducer alone SHALL select the legal successor

#### Scenario: Researcher requests closure
- **WHEN** a researcher message or artifact asks the engine to close research or bypass wiki approval
- **THEN** the engine SHALL not treat that request as lifecycle authority
- **AND** only an authorized developer `close-research` action or the registered wiki approval edge can transition the workflow to `core.closed`

#### Scenario: Agent process settles without handoff
- **WHEN** an adapter observes idle or exited runtime but no valid handoff exists
- **THEN** the workflow SHALL remain awaiting the current research run or follow explicit retry/recovery policy
- **AND** runtime status alone SHALL not complete the step

### Requirement: Adapter-independent behavior
Pi, OpenCode, OpenCode V2, and future adapters SHALL transport the same rendered assignment and generic handoff protocol without embedding workflow semantics in the adapter. Research lifecycle, follow-up availability, tool-neutral web policy, optional repository boundary, and explicit close semantics SHALL remain identical across adapters.

#### Scenario: Same step uses another runtime
- **WHEN** routing changes from Pi to OpenCode for a newly created workflow
- **THEN** assignment fields, output contract, reducer outcomes, and handoff semantics SHALL remain unchanged
- **AND** only launch, prompt transport, status observation, and runtime telemetry bridge SHALL differ

### Requirement: A developer abort is recorded as a blocked handoff

When the developer aborts a managed run from the dashboard or orchestrator session, the durable host SHALL record that run's `blocked` outcome with a bounded message naming the abort, before the run's turn is torn down. The handoff SHALL use the run's own launch-bound capability, SHALL be marked as a developer abort (which keeps that capability as the durable marker of a reopenable park), and SHALL be best-effort: a run that already handed off, or a handoff the engine rejects, SHALL leave the workflow unchanged and SHALL NOT fail the abort. A host teardown that stops runs without a developer abort (workflow close, deletion, host shutdown) SHALL NOT record a blocked handoff.

#### Scenario: Developer aborts a working run

- **WHEN** the developer aborts a run whose conversation is mid-turn
- **THEN** the run's capability SHALL record `blocked`, marked as a developer abort, with a bounded abort message
- **AND** the workflow SHALL show the step as `attention-required` instead of leaving the run `working`

#### Scenario: Abort of a finished run

- **WHEN** the developer aborts a run that has already completed or handed off
- **THEN** the abort SHALL succeed
- **AND** the workflow's recorded state SHALL remain unchanged

#### Scenario: Teardown does not block a run

- **WHEN** the workflow closes, is deleted, or the host shuts down and stops its runs
- **THEN** no `blocked` handoff SHALL be recorded for those runs

### Requirement: An aborted run reopens for the developer's next message

An aborted run SHALL be parked `blocked` only while nobody is working in it. Before the durable host delivers a prompt to a run it aborted, it SHALL reconcile that run's workflow state with the engine through the run's own launch-bound capability, and the engine SHALL reopen exactly that run when it is still the current attempt of its step: the run becomes `working` again, the abort's own attention entry is cleared, and the workflow returns to `active` — recorded as a durable `agent.resumed` event. Reopening SHALL NOT clear a park the agent itself recorded (`blocked` without the abort marker), SHALL NOT reopen a run that already handed off, failed, expired, or whose step moved on, and SHALL NOT change any state for such a run. The reconcile SHALL be best-effort: a failure to reach the engine SHALL leave the recorded state unchanged and SHALL NOT discard the developer's message. The usual handoff SHALL work again for the reopened run.

#### Scenario: Developer speaks to an aborted run

- **WHEN** the developer sends a message to a run the host aborted
- **THEN** the engine SHALL reopen that run (`working`), clear the abort's attention entry, and set the workflow back to `active`
- **AND** the transition SHALL be recorded as an `agent.resumed` event
- **AND** the run's later handoff SHALL be accepted

#### Scenario: Park recorded before the abort marker

- **WHEN** the run was parked `blocked` with the bounded abort message by a host that predates the abort marker, so no capability is left
- **THEN** the engine SHALL reopen it only for a caller that still holds the run's own launch token, verified against the run's launch environment file
- **AND** it SHALL bind that token as the reopened run's capability, so the run's later handoff is accepted
- **AND** an unverifiable caller SHALL be refused and the park SHALL remain

#### Scenario: The message is unrelated to another park

- **WHEN** a run handed off `blocked` itself (its own blocker, or a question asker) and the developer sends a message
- **THEN** the engine SHALL refuse to reopen it and the workflow SHALL remain `attention-required`
- **AND** the message SHALL still reach the run's session

#### Scenario: The run already finished

- **WHEN** the developer sends a message to a run that already handed off, failed or expired
- **THEN** the engine SHALL report that state without changing it
- **AND** the host SHALL report the state to the client together with the accepted submission

