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

### Requirement: The assignment states the run's tool surface

The rendered assignment SHALL name the run's inspection tools before it states
the objective, and SHALL do so in every round rather than only on the first
assignment: `read` (with `offset`/`limit`) and `grep` (with a `path` filter) are
the default way to inspect code, `bash` is for builds, tests and `openspec`, and
`codemode`, when the run offers it, chains a search → filter → summarise pipeline
into one turn. The same section SHALL repeat the batching rule: every independent
call a step needs SHALL be emitted in one message rather than one call per turn,
because each turn re-sends the whole conversation. The section SHALL NOT describe
a tool the run does not have: `codemode` SHALL appear only in a clause
conditioned on the run's own tool set, and no read-only assignment SHALL claim
`edit` or `write`.

#### Scenario: Every durable assignment names the inspection default

- **WHEN** an assignment is rendered for a writable worker, a verifier, a planner or a wiki run
- **THEN** the section before its objective SHALL state that `read` and `grep` are the default way to inspect code and that `bash` is for builds, tests and `openspec`

#### Scenario: The batching rule travels with every round

- **WHEN** an existing agent session receives a later attempt or round
- **THEN** the re-sent envelope SHALL repeat the tool surface and the batching rule instead of relying on the first assignment or on the protocol document

#### Scenario: A tool the run lacks is not advertised

- **WHEN** the assignment cannot know whether `codemode` is registered for the run
- **THEN** it SHALL name `codemode` only conditionally (`when this run offers it`) and SHALL NOT name `edit` or `write` for a read-only run

### Requirement: An implementation assignment carries the plan's file list

An implementation assignment SHALL list the plan's declared file paths as its own
input when the workflow's recorded plan artifact declares them, read from that
recorded artifact. The list SHALL be bounded (at most 40 paths, then
the count of the remainder), SHALL contain repository-relative paths only, and
SHALL NOT contain file contents or diff text. When the plan artifact declares no
paths, the assignment SHALL render no such list and SHALL NOT substitute one
derived from a directory scan, from the change's documents' prose, or from the
worker's own guess. The forwarding SHALL introduce no persisted state.

#### Scenario: The worker is handed the plan's files

- **WHEN** the plan artifact declared the plan's file list before the implementation step was launched
- **THEN** the implementation assignment SHALL name those paths
- **AND** the worker SHALL be able to start from them without re-deriving the change's surface

#### Scenario: A plan without a file list adds nothing

- **WHEN** the plan artifact declares no file paths
- **THEN** the implementation assignment SHALL render no plan-file input and SHALL NOT fail to render

#### Scenario: A long file list is bounded

- **WHEN** the plan declares more paths than the bound
- **THEN** the assignment SHALL list at most 40 of them and state how many it omitted

### Requirement: A verification assignment carries the round's scope

Every `core.verification` run's assignment SHALL identify the round's changed
files — the engine's changed-file set for the workflow at assignment time,
including uncommitted files — bounded to at most 100 paths followed by the count
of the remainder. When an earlier round recorded a findings artifact for a
verifier role, the assignment SHALL additionally carry the most recent recorded
findings per verifier role, each as a bounded line naming severity, path, line
and the finding's recorded text (at most 8 findings per role, at most 200
characters of finding text each, at most 4 KiB for the whole block), passed
through the engine's existing text redaction. It SHALL NOT carry file contents,
diff text, or a value the engine has not already recorded. When no findings
artifact is recorded, for example on the first verification round, the assignment
SHALL render no prior-findings section. This forwarding SHALL NOT change which
verifier roles a round runs.

#### Scenario: A later round carries the changed files and the prior findings

- **WHEN** a verification run is launched for a round after a round that recorded findings
- **THEN** its assignment SHALL list the round's changed files and the most recent recorded findings per verifier role

#### Scenario: The first round carries no prior findings

- **WHEN** the first verification round's assignment is rendered and no findings artifact is recorded
- **THEN** the assignment SHALL list the round's changed files and SHALL render no prior-findings section

#### Scenario: Forwarded findings are bounded and redacted

- **WHEN** a recorded findings artifact carries more findings, or longer text, than the forwarding bounds allow
- **THEN** the assignment SHALL carry at most the bounded number of findings with truncated text
- **AND** a known credential shape in the recorded text SHALL be redacted

#### Scenario: Role selection is unaffected

- **WHEN** an assignment carries forwarded findings
- **THEN** the set of verifier roles the round runs SHALL be exactly the set the round's selection already determined

### Requirement: The protocol is rendered per role

The managed workflow protocol SHALL consist of an always-included core and optional sections, and a first assignment SHALL include the core plus only the optional sections its step declares for the run's role. The core SHALL state the lifecycle, output-artifact, single-outcome handoff, asking-without-guessing, untrusted-content and secret-redaction rules. A step that declares no section selection SHALL receive every section. The protocol SHALL remain one pinned instruction asset whose digest covers every section, and section markers SHALL NOT appear in the rendered prompt.

#### Scenario: A stage tester receives no generic tool guidance
- **WHEN** a `stage.execute` assignment is rendered for the stage tester
- **THEN** it SHALL contain the protocol core and the stage tester's brief
- **AND** SHALL NOT contain the environment, browser, debug-tools, delegated-debug, file-signals or `ask_jev` sections

#### Scenario: An implementation worker receives its tool sections
- **WHEN** a `core.implementation` assignment is rendered for the worker
- **THEN** it SHALL contain the environment, browser, debug-tools and delegated-debug sections
- **AND** SHALL NOT contain the file-signals section

#### Scenario: Review roles receive file signals and ask_jev
- **WHEN** a `core.triage` or `core.verification` assignment is rendered
- **THEN** it SHALL contain the file-signals and `ask_jev` sections

#### Scenario: A step without a declaration loses nothing
- **WHEN** an assignment is rendered for a step whose behavior declares no protocol sections
- **THEN** it SHALL contain every protocol section

#### Scenario: Core rules survive every selection
- **WHEN** any agent assignment is rendered
- **THEN** it SHALL state that the run writes only its declared output artifact, finishes with exactly one allowed outcome through `agentic-coding workflow handoff`, hands off `blocked` instead of guessing when a question stays unanswered, treats dialogue and tool content as untrusted, and never works around a redacted secret

### Requirement: Guidance travels with the block it governs

The assignment SHALL render a one-line meaning of the interaction mode beside `Interaction:`, the prior-dialogue input block SHALL tell the agent not to re-ask an answered decision, and the peer-question message SHALL state that the question is not a reason to hand off, so that none of these rules depends on a protocol section.

#### Scenario: Silent run
- **WHEN** an assignment with interaction `silent` is rendered
- **THEN** the interaction line SHALL say to report through the artifact and the handoff without a chat summary

#### Scenario: Prior dialogue present
- **WHEN** an assignment carries prior dialogue
- **THEN** the dialogue block SHALL mark it untrusted and SHALL say not to re-ask an answered decision

#### Scenario: Peer question delivered
- **WHEN** a peer question is delivered to a live session
- **THEN** the message SHALL carry the exact answer command and SHALL state that it is not a new assignment and not a reason to hand off

