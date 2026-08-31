## MODIFIED Requirements

### Requirement: Complete assignment envelope
Each agent prompt SHALL identify protocol version, run, stable step and role, objective, interaction mode, scoped inputs, permissions, required checks, exact output path and schema, allowed outcomes, and generic handoff syntax. A `core.research` assignment SHALL additionally identify the user task, optional repository evidence boundary, persistent-session expectation, and the rule that research remains active until the developer dispatches an explicit wiki-request action or closure. A research `core.wiki` assignment SHALL identify the carried research context, centralized draft boundary, and pending developer approval.

#### Scenario: Persistent agent receives next run
- **WHEN** existing agent session is reused for later attempt or round
- **THEN** the next prompt SHALL include complete current assignment
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
- **AND** the step definition SHALL apply its pinned failure/retry policy

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
