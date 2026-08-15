## Purpose

Defines one agent-product-independent assignment and handoff protocol so every managed agent receives complete Markdown instructions as a message and can never mutate workflow lifecycle directly.

## ADDED Requirements

### Requirement: Skill-free instruction delivery
Managed workflow agents SHALL NOT load, invoke, or discover workflow skills; engine SHALL render trusted Markdown protocol and step instruction assets into assignment message.

#### Scenario: Agent run starts
- **WHEN** adapter launches managed run
- **THEN** runtime arguments/configuration SHALL not reference workflow `SKILL.md` or skill invocation
- **AND** engine SHALL send rendered Markdown instructions and dynamic assignment as normal agent message

#### Scenario: Runtime has native skill support
- **WHEN** selected runtime can load skills automatically
- **THEN** workflow instruction delivery SHALL remain message-based
- **AND** workflow correctness SHALL NOT depend on runtime skill mechanism

### Requirement: Complete assignment envelope
Each agent prompt SHALL identify protocol version, run, stable step and role, objective, interaction mode, scoped inputs, permissions, required checks, exact output path and schema, allowed outcomes, and generic handoff syntax.

#### Scenario: Persistent agent receives next run
- **WHEN** existing agent session is reused for later attempt or round
- **THEN** next prompt SHALL include complete current assignment
- **AND** agent SHALL NOT need prior prompt context to determine scope or handoff

#### Scenario: Assignment cannot be rendered safely
- **WHEN** required instruction asset is missing, changed from pinned digest, oversized, or assignment data is invalid
- **THEN** launch SHALL fail before prompt delivery
- **AND** run SHALL NOT be presented as working

### Requirement: Runtime-neutral handoff command
Every managed agent SHALL report only `complete`, `blocked`, or `failed` through one generic `agentic-coding workflow handoff` command whose workflow, role, run, capability, and run generation come from engine-provided environment.

#### Scenario: Agent completes assignment
- **WHEN** agent writes required output and invokes handoff with `complete`
- **THEN** agent SHALL provide only outcome and declared artifact
- **AND** engine SHALL derive workflow and run identity without agent-supplied phase, role, change ID, or successor

#### Scenario: Agent is blocked
- **WHEN** agent cannot continue without clarification or operator action
- **THEN** it SHALL hand off `blocked` with bounded message
- **AND** step definition SHALL route blocker to configured responder or dashboard without agent choosing recipient

#### Scenario: Agent fails assignment
- **WHEN** agent encounters non-recoverable execution failure
- **THEN** it SHALL hand off `failed` with bounded diagnostic
- **AND** engine SHALL apply pinned step failure/retry policy

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
Assignment protocol SHALL prohibit agents from naming target step, phase, next role, or effect and engine SHALL ignore any such fields if present outside output schema.

#### Scenario: Output requests phase change
- **WHEN** agent artifact includes undeclared phase or successor field
- **THEN** output schema validation SHALL reject it or discard it as unknown according to schema
- **AND** registered reducer alone SHALL select legal successor

#### Scenario: Agent process settles without handoff
- **WHEN** adapter observes idle or exited runtime but no valid handoff exists
- **THEN** workflow SHALL remain awaiting current run or follow explicit timeout policy
- **AND** runtime status alone SHALL NOT complete step

### Requirement: Adapter-independent behavior
Pi, OpenCode, OpenCode V2, and future adapters SHALL transport same rendered assignment and generic handoff protocol without embedding workflow semantics in adapter.

#### Scenario: Same step uses another runtime
- **WHEN** routing changes from Pi to OpenCode for newly created workflow
- **THEN** assignment fields, output contract, reducer outcomes, and handoff semantics SHALL remain unchanged
- **AND** only launch, prompt transport, status observation, and runtime telemetry bridge SHALL differ
