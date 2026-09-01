## MODIFIED Requirements

### Requirement: Researcher may hand off to a reviewed wiki draft only on explicit request
During the active research stage, the researcher SHALL remain interactive until the user explicitly requests a wiki entry. Once the user explicitly requests a wiki entry, the researcher SHALL record a structured handoff — a subject, a canonical wiki target when one is known, a findings/outline summary, and source citations — while still interactively active and before any developer dispatch of `request-research-wiki`. The developer SHALL then dispatch the authenticated `request-research-wiki` action. The workflow SHALL reject `request-research-wiki` when no valid handoff has been recorded for the active research run, and SHALL report an actionable reason instead of proceeding without one. Only when a valid handoff exists SHALL `request-research-wiki` expire the researcher run and enter `core.wiki`; the dedicated wiki role SHALL receive the full recorded handoff content as its primary input, in addition to the task and any repository context, and SHALL search, inspect, and write centralized concepts. Wiki writing SHALL use the existing OKF v0.2 conventions, update an intended existing concept in place before creating a near-duplicate, use project-aware namespaces when repository context exists, and produce an unverified draft. The researcher and wiki agent SHALL not verify concepts or set human-reviewed metadata; a developer approves the draft in `core.wiki-approval`.

#### Scenario: No implicit wiki write
- **WHEN** the researcher completes a research answer without an explicit wiki-entry request
- **THEN** it does not hand off `complete`, and no wiki concept is written
- **AND** no handoff is required while research stays purely conversational

#### Scenario: User requests a wiki draft
- **WHEN** the user explicitly asks for a wiki entry
- **THEN** the researcher records a structured handoff (subject, canonical target if known, findings/outline, and source citations) while still interactively active
- **AND** the developer may dispatch the authenticated `request-research-wiki` action to enter `core.wiki`
- **AND** the authenticated wiki run may create or update a centralized OKF draft
- **AND** the workflow enters `core.wiki-approval` after wiki drafting for developer review

#### Scenario: Wiki request without a recorded handoff is rejected
- **WHEN** the developer dispatches `request-research-wiki` before the researcher has recorded a valid handoff
- **THEN** the workflow rejects the request with an actionable message
- **AND** the researcher run is not expired or stopped
- **AND** the workflow remains at `core.research`

#### Scenario: Valid handoff gates the wiki transition
- **WHEN** the researcher has recorded a valid handoff and the developer dispatches `request-research-wiki`
- **THEN** the researcher run is expired and its session is stopped only after the handoff is confirmed valid
- **AND** the workflow transitions to `core.wiki`

#### Scenario: Wiki stage receives the full handoff as primary input
- **WHEN** `core.wiki` starts after a valid handoff gated the transition
- **THEN** the wiki role's assignment includes the full recorded subject, canonical target if known, findings/outline, and source citations from the handoff
- **AND** the wiki role is not limited to a best-effort, size-truncated, or partial summary of the research session

#### Scenario: Recording a handoff does not itself write to the wiki or mutate the repository
- **WHEN** the researcher records a structured handoff
- **THEN** no centralized wiki concept is created or updated as a side effect of recording it
- **AND** the supplied repository, if any, remains unchanged
- **AND** the researcher remains interactive and able to answer further follow-ups until `request-research-wiki` or `close-research` is dispatched

#### Scenario: Existing concept is preferred
- **WHEN** a related concept already covers the requested research subject
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
