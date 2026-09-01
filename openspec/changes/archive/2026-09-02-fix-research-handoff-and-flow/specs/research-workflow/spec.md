## MODIFIED Requirements

### Requirement: Researcher may hand off to a reviewed wiki draft only on explicit request
During the active research stage, the researcher SHALL remain interactive until the user explicitly requests a wiki entry. Once the user explicitly requests a wiki entry, the researcher SHALL dispatch a single authenticated researcher-initiated handoff command that both records a structured handoff and requests the transition into wiki drafting; there SHALL be no separate developer dashboard action required to start wiki drafting. The structured handoff SHALL include a subject, an optional canonical wiki target when one is known, source citations (or an explicit no-sources marker), an optional freeform narrative field for context the structured fields cannot capture, and a list of per-concept documentation directives. Each directive SHALL name a target concept (an existing concept identifier to update, or a new-concept marker with a proposed project-scoped identifier), a create-or-update intent, the specific source-backed claims or facts to document, and supporting citations. The command SHALL reject the transition when the handoff is invalid or missing required content, when source-isolation validation for the supplied repository fails, or when the workspace is not ready, and SHALL report an actionable reason instead of proceeding. Only when the handoff is valid and the checks pass SHALL the command expire the researcher run, stop its session, and enter `core.wiki`. The dedicated wiki role SHALL receive the full recorded handoff content — including every documentation directive and the freeform narrative — as its primary actionable input, in addition to the task and any repository context, and SHALL search, inspect, and write centralized concepts. Wiki writing SHALL use the existing OKF v0.2 conventions, update an intended existing concept in place before creating a near-duplicate, use project-aware namespaces when repository context exists, and produce an unverified draft. The researcher and wiki agent SHALL not verify concepts or set human-reviewed metadata; a developer approves the draft in `core.wiki-approval`.

#### Scenario: No implicit wiki write
- **WHEN** the researcher completes a research answer without an explicit wiki-entry request
- **THEN** it does not hand off `complete`, dispatches no handoff command, and no wiki concept is written
- **AND** no handoff is required while research stays purely conversational

#### Scenario: User requests a wiki draft
- **WHEN** the user explicitly asks for a wiki entry
- **THEN** the researcher dispatches the authenticated researcher-initiated handoff command with a subject, optional canonical target, citations or a no-sources marker, an optional freeform narrative, and one or more per-concept documentation directives
- **AND** the workflow validates the handoff and, when valid, transitions from `core.research` to `core.wiki`
- **AND** the authenticated wiki run may create or update a centralized OKF draft
- **AND** the workflow enters `core.wiki-approval` after wiki drafting for developer review

#### Scenario: No separate developer dashboard trigger for wiki drafting
- **WHEN** research is active
- **THEN** the developer is not offered a dashboard action to start wiki drafting
- **AND** the only path into `core.wiki` is the researcher-initiated handoff command dispatched on an explicit user request

#### Scenario: Wiki request without a recorded handoff is rejected
- **WHEN** the researcher dispatches the handoff command but the handoff is missing or invalid (for example no valid per-concept documentation directive, or malformed content)
- **THEN** the workflow rejects the command with an actionable message
- **AND** the researcher run is not expired or stopped
- **AND** the workflow remains at `core.research`

#### Scenario: Handoff with a failed safety check keeps research active
- **WHEN** the researcher dispatches an otherwise valid handoff command but source-isolation validation for the supplied repository fails or the workspace is not ready
- **THEN** the workflow rejects the command with an actionable message
- **AND** the researcher run is not expired or stopped
- **AND** the workflow remains at `core.research`

#### Scenario: Valid handoff gates the wiki transition
- **WHEN** the researcher dispatches a valid handoff command and all safety checks pass
- **THEN** the researcher run is expired and its session is stopped only after the handoff is confirmed valid
- **AND** the workflow transitions to `core.wiki`

#### Scenario: Wiki stage receives the full handoff as primary input
- **WHEN** `core.wiki` starts after a valid handoff gated the transition
- **THEN** the wiki role's assignment includes the full recorded subject, canonical target if known, every per-concept documentation directive with its intent and source-backed claims, the freeform narrative, and source citations from the handoff
- **AND** the wiki role is directed to treat the documentation directives as its actionable starting point for which concepts to create or update and what to document
- **AND** the wiki role is not limited to a best-effort, size-truncated, or partial summary of the research session

#### Scenario: Recording a handoff does not itself write to the wiki or mutate the repository
- **WHEN** the researcher dispatches the handoff command and it is rejected by a validity or safety check before any transition
- **THEN** no centralized wiki concept is created or updated as a side effect
- **AND** the supplied repository, if any, remains unchanged
- **AND** the researcher remains interactive and able to answer further follow-ups until a valid handoff or `close-research`

#### Scenario: Existing concept is preferred
- **WHEN** a related concept already covers a requested documentation directive's subject
- **THEN** the wiki agent updates that canonical concept in place rather than creating an active duplicate

#### Scenario: Draft remains unverified
- **WHEN** the wiki agent writes a wiki entry
- **THEN** it carries draft status, generated provenance, and source citations
- **AND** it has no human verification event and is not promoted to stable by the researcher

#### Scenario: Wiki write cannot modify source repository
- **WHEN** the wiki agent creates or updates a wiki draft during repository-context research
- **THEN** only the centralized wiki output changes
- **AND** the supplied repository remains unchanged
- **AND** developer approval is required before the workflow reaches `core.closed`

### Requirement: Only explicit user closure ends research
The system SHALL expose a developer-only `close-research` action while a research workflow is in any active research, wiki drafting, or wiki approval step. The action SHALL directly transition the workflow to `core.closed`, expire any active agent run, and stop any launched session through the existing effect mechanism. Researcher output or ordinary agent handoff SHALL not close the workflow implicitly. The set of developer-dispatched actions available during the active research step SHALL NOT include a wiki-drafting trigger; the transition into wiki drafting is initiated only by the researcher-initiated handoff command on an explicit user request.

#### Scenario: User closes active research
- **WHEN** the developer dispatches `close-research` with the current workflow revision from any active research workflow step
- **THEN** the workflow transitions to `core.closed`
- **AND** active researcher runs are expired and their sessions are stopped when handles exist

#### Scenario: Close works when researcher is unavailable
- **WHEN** the researcher runtime is stopped or unreachable and the developer dispatches `close-research`
- **THEN** the workflow still transitions to `core.closed`
- **AND** closure does not wait for a final researcher handoff

#### Scenario: Non-developer cannot close research
- **WHEN** an agent or unauthenticated caller attempts `close-research`
- **THEN** the command is rejected without changing workflow state

#### Scenario: No developer wiki-drafting action during research
- **WHEN** research is active and the developer inspects the available workflow actions
- **THEN** `close-research` (and follow-up dialogue) is available
- **AND** no developer action to start or request wiki drafting is offered

#### Scenario: Repeated close is safe
- **WHEN** `close-research` is dispatched after the workflow is already closed
- **THEN** the command is unavailable or idempotently reports the closed state
- **AND** no duplicate stop effect or lifecycle transition is created
