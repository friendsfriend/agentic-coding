## MODIFIED Requirements

### Requirement: Research workflow has an explicit research-to-wiki lifecycle
The system SHALL provide a versioned `research` workflow whose successful path is `core.research` → `core.wiki` → `core.wiki-approval` → `core.completed` → `core.closed`. The workflow SHALL start at `core.research`, use the common `core.closed` terminal lifecycle marker, and SHALL contain no implementation, verification, review, archive, delivery, or pull-request stage. After the developer approves the reviewed wiki draft at `core.wiki-approval`, the workflow SHALL transition to `core.completed` rather than directly to `core.closed`, so that closing the workspace is an explicit developer action taken after wiki approval.

#### Scenario: Research definition is registered
- **WHEN** the built-in workflow catalog initializes
- **THEN** it exposes a pinned `research` definition with `core.research` as its initial step and `core.closed` as its terminal step
- **AND** the definition includes `core.research`, `core.wiki`, `core.wiki-approval`, `core.completed`, and the common terminal lifecycle step

#### Scenario: Research graph excludes code-changing paths
- **WHEN** the registry validates the `research` definition
- **THEN** no reachable edge launches implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Wiki approval leads to an explicit close gate
- **WHEN** the developer approves the reviewed wiki draft at `core.wiki-approval`
- **THEN** the workflow transitions to `core.completed` and does not close automatically
- **AND** the developer must dispatch an explicit close action from `core.completed` to reach `core.closed`

#### Scenario: Definition is pinned
- **WHEN** a research workflow starts
- **THEN** its exact definition identifier, version, and digest are persisted and all later commands use that pin

### Requirement: Only explicit user closure ends research
The system SHALL expose a developer-only `close-research` action while a research workflow is in the active `core.research` step and no wiki handoff has occurred yet. Once the researcher hands off into wiki drafting, `close-research` SHALL NOT be available during `core.wiki` or `core.wiki-approval`; the only forward paths from those steps SHALL be wiki drafting, developer approval, or requesting wiki changes. After wiki approval the workflow SHALL reach `core.completed`, where the developer SHALL close the workspace through an explicit `close` action. The `close-research` action, when available, SHALL directly transition the workflow to `core.closed`, expire any active agent run, and stop any launched session through the existing effect mechanism. Researcher output or ordinary agent handoff SHALL not close the workflow implicitly. The set of developer-dispatched actions available during the active research step SHALL NOT include a wiki-drafting trigger; the transition into wiki drafting is initiated only by the researcher-initiated handoff command on an explicit user request.

#### Scenario: User closes active research
- **WHEN** research is active at `core.research`, no wiki handoff has occurred, and the developer dispatches `close-research` with the current workflow revision
- **THEN** the workflow transitions to `core.closed`
- **AND** active researcher runs are expired and their sessions are stopped when handles exist

#### Scenario: Close-research is unavailable after handoff
- **WHEN** the researcher has handed off and the workflow is at `core.wiki` or `core.wiki-approval`
- **THEN** the developer is not offered `close-research`
- **AND** the only developer actions offered at `core.wiki-approval` are wiki approval and requesting wiki changes

#### Scenario: Closing after wiki approval is an explicit completed action
- **WHEN** the developer has approved the wiki draft and the workflow is at `core.completed`
- **THEN** the developer is offered an explicit action to close the workspace
- **AND** dispatching that close action transitions the workflow to `core.closed`

#### Scenario: Close works when researcher is unavailable
- **WHEN** the researcher runtime is stopped or unreachable, research is at `core.research` with no handoff, and the developer dispatches `close-research`
- **THEN** the workflow still transitions to `core.closed`
- **AND** closure does not wait for a final researcher handoff

#### Scenario: Non-developer cannot close research
- **WHEN** an agent or unauthenticated caller attempts `close-research`
- **THEN** the command is rejected without changing workflow state

#### Scenario: No developer wiki-drafting action during research
- **WHEN** research is active at `core.research` and the developer inspects the available workflow actions
- **THEN** `close-research` (and follow-up dialogue) is available
- **AND** no developer action to start or request wiki drafting is offered

#### Scenario: Repeated close is safe
- **WHEN** `close-research` is dispatched after the workflow is already closed
- **THEN** the command is unavailable or idempotently reports the closed state
- **AND** no duplicate stop effect or lifecycle transition is created

### Requirement: Researcher may hand off to a reviewed wiki draft only on explicit request
During the active research stage, the researcher SHALL remain interactive until the user explicitly requests a wiki entry. Once the user explicitly requests a wiki entry, the researcher SHALL dispatch a single authenticated researcher-initiated handoff command that both records a structured handoff and requests the transition into wiki drafting; there SHALL be no separate developer dashboard action required to start wiki drafting. The structured handoff SHALL include a subject, an optional canonical wiki target when one is known, source citations (or an explicit no-sources marker), an optional freeform narrative field for context the structured fields cannot capture, and a list of per-concept documentation directives. Each directive SHALL name a target concept (an existing concept identifier to update, or a new-concept marker with a proposed project-scoped identifier), a create-or-update intent, the specific source-backed claims or facts to document, and supporting citations. The command SHALL reject the transition when the handoff is invalid or missing required content, when source-isolation validation for the supplied repository fails, or when the workspace is not ready, and SHALL report an actionable reason instead of proceeding. Only when the handoff is valid and the checks pass SHALL the command expire the researcher run, stop its session, and enter `core.wiki`. The dedicated `research-wiki` role SHALL receive the full recorded handoff content — including every documentation directive and the freeform narrative — as its primary actionable input, in addition to the task and any repository context. The `research-wiki` role's assignment and its dedicated instructions SHALL direct it to act directive-first: it SHALL begin by creating or updating exactly the concepts named by the directives with the claims each directive lists, and SHALL limit its repository and centralized-wiki inspection to targeted corroboration of those directives, rather than performing broad open-ended rediscovery to decide what to document. This directive-first behavior is inherent to the distinct `research-wiki` role and SHALL NOT alter the separate `wiki` role's openspec/implementation `core.wiki` behavior, which receives no directives and continues to discover what to document. Wiki writing SHALL use the existing OKF v0.2 conventions, update an intended existing concept in place before creating a near-duplicate, use project-aware namespaces when repository context exists, and produce an unverified draft. The researcher and research-wiki agent SHALL not verify concepts or set human-reviewed metadata; a developer approves the draft in `core.wiki-approval`.

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

#### Scenario: Wiki stage acts directive-first
- **WHEN** `core.wiki` starts after a valid research handoff
- **THEN** the research-wiki role's assignment directs it to first create or update exactly the concepts named by the recorded directives with the claims each directive lists
- **AND** the assignment directs it to limit repository and centralized-wiki inspection to targeted corroboration of those directives rather than broad open-ended rediscovery of what to document

#### Scenario: Directive-first scoping does not affect openspec wiki
- **WHEN** the `core.wiki` step runs in an openspec/implementation workflow with no research handoff or directives
- **THEN** the separate `wiki` role's assignment and instructions retain their existing discovery-based behavior
- **AND** the directive-first research-handoff guidance does not apply

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
- **THEN** the research-wiki role's assignment includes the full recorded subject, canonical target if known, every per-concept documentation directive with its intent and source-backed claims, the freeform narrative, and source citations from the handoff
- **AND** the research-wiki role is directed to treat the documentation directives as its actionable starting point for which concepts to create or update and what to document
- **AND** the research-wiki role is not limited to a best-effort, size-truncated, or partial summary of the research session

#### Scenario: Recording a handoff does not itself write to the wiki or mutate the repository
- **WHEN** the researcher dispatches the handoff command and it is rejected by a validity or safety check before any transition
- **THEN** no centralized wiki concept is created or updated as a side effect
- **AND** the supplied repository, if any, remains unchanged
- **AND** the researcher remains interactive and able to answer further follow-ups until a valid handoff or `close-research`

#### Scenario: Existing concept is preferred
- **WHEN** a related concept already covers a requested documentation directive's subject
- **THEN** the research-wiki agent updates that canonical concept in place rather than creating an active duplicate

#### Scenario: Draft remains unverified
- **WHEN** the research-wiki agent writes a wiki entry
- **THEN** it carries draft status, generated provenance, and source citations
- **AND** it has no human verification event and is not promoted to stable by the researcher

#### Scenario: Wiki write cannot modify source repository
- **WHEN** the research-wiki agent creates or updates a wiki draft during repository-context research
- **THEN** only the centralized wiki output changes
- **AND** the supplied repository remains unchanged
- **AND** developer approval is required before the workflow reaches `core.closed`

## ADDED Requirements

### Requirement: Research wiki approval uses the standard line-anchored wiki review
The system SHALL review the research flow's drafted wiki entries at `core.wiki-approval` using the same line-anchored wiki review popup the standard flows use (the wiki-only and openspec workflows), rather than a generic action-notice list. When the research workflow reaches `core.wiki-approval`, the dashboard SHALL open the wiki review popup listing the concepts the wiki run touched, allow opening each concept in a markdown view, and allow anchoring review comments to source lines. Finishing the review SHALL dispatch wiki approval when there are no comments and dispatch the review-comments action with a bounded payload when comments exist, exactly as the standard flows do. The research flow SHALL NOT expose `close-research` as an option within this review.

#### Scenario: Research wiki approval opens the standard review popup
- **WHEN** the research workflow reaches `core.wiki-approval`
- **THEN** the dashboard opens the same line-anchored wiki review popup used by the standard flows, listing the drafted concepts
- **AND** the generic action-notice list is not shown for this gate

#### Scenario: Approving research wiki drafts without comments
- **WHEN** the developer finishes the research wiki review with no comments
- **THEN** the workflow dispatches the wiki approval action
- **AND** the workflow transitions from `core.wiki-approval` to `core.completed`

#### Scenario: Requesting changes on research wiki drafts
- **WHEN** the developer finishes the research wiki review with one or more comments
- **THEN** the workflow saves the comments and dispatches the review-comments action with a bounded payload
- **AND** the workflow returns to `core.wiki` so the research-wiki agent can revise the drafts

#### Scenario: No close-research within the review
- **WHEN** the research wiki review popup is open at `core.wiki-approval`
- **THEN** the review offers approval and requesting changes
- **AND** it does not offer `close-research` as an option
