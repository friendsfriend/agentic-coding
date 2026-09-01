# research-workflow Specification

## Purpose
TBD - created by archiving change introduce-research-workflow. Update Purpose after archive.

## Requirements

### Requirement: Research workflow has an explicit research-to-wiki lifecycle
The system SHALL provide a versioned `research` workflow whose successful path is `core.research` → `core.wiki` → `core.wiki-approval` → `core.closed`. The workflow SHALL start at `core.research`, use the common `core.closed` terminal lifecycle marker, and SHALL contain no implementation, verification, review, archive, delivery, or pull-request stage.

#### Scenario: Research definition is registered
- **WHEN** the built-in workflow catalog initializes
- **THEN** it exposes a pinned `research` definition with `core.research` as its initial step and `core.closed` as its terminal step
- **AND** the definition includes `core.research`, `core.wiki`, `core.wiki-approval`, and the common terminal lifecycle step

#### Scenario: Research graph excludes code-changing paths
- **WHEN** the registry validates the `research` definition
- **THEN** no reachable edge launches implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Definition is pinned
- **WHEN** a research workflow starts
- **THEN** its exact definition identifier, version, and digest are persisted and all later commands use that pin

### Requirement: Research accepts task input with optional repository context
The system SHALL require a non-empty research task and SHALL allow the workflow to start either without a repository or with a valid repository path supplied as optional read-only context. Standalone research SHALL not require a checkout, branch, worktree, OpenSpec project, clean working tree, or workflow mode. Repository-context research SHALL require a read-only researcher profile and the supplied repository SHALL remain unchanged by the researcher.

#### Scenario: Standalone research starts
- **WHEN** a user starts `research` with a non-empty task and no repository
- **THEN** startup succeeds without repository, branch, worktree, mode, or OpenSpec validation
- **AND** the workflow records an empty repository context

#### Scenario: Repository-context research starts
- **WHEN** a user starts `research` with a non-empty task and a valid repository path
- **THEN** startup succeeds without creating or switching a branch or worktree
- **AND** the researcher receives the repository as read-only evidence context

#### Scenario: Invalid repository context is rejected safely
- **WHEN** a supplied repository path is not a valid readable repository
- **THEN** startup fails before researcher effects launch
- **AND** no repository content is modified

#### Scenario: Repository mutation is not accepted
- **WHEN** a researcher run with repository context creates, edits, deletes, stages, or commits source-repository content
- **THEN** the workflow rejects or blocks the mutation and does not present it as a valid research result

### Requirement: Researcher supports ongoing follow-up dialogue
The system SHALL route `core.research` to a dedicated `researcher` role using a persistent interactive session when the selected runtime supports the required capabilities. The workflow SHALL remain active while the researcher answers follow-up questions, and runtime settlement, an answer, output-file existence, or absence of a handoff SHALL not close or complete the workflow.

#### Scenario: Initial research session is launched
- **WHEN** a valid research workflow starts
- **THEN** one researcher run is launched with the task and optional repository context
- **AND** the assignment requests prompt, interactive, persistent-session, run-environment, and observe capabilities

#### Scenario: Researcher answers without closing
- **WHEN** the researcher responds to the initial task or a follow-up without a completion handoff
- **THEN** the workflow remains active at `core.research`
- **AND** the user can send another follow-up to the same researcher session

#### Scenario: Runtime settles without handoff
- **WHEN** the selected researcher runtime exits or becomes idle without a valid handoff
- **THEN** the workflow remains at `core.research` and does not infer completion from runtime status

#### Scenario: Follow-up uses the same research context
- **WHEN** the user sends a follow-up while research is active
- **THEN** the prompt is delivered to the active researcher run/session with the original task, prior relevant dialogue, and repository-context boundary

### Requirement: Only explicit user closure ends research
The system SHALL expose a developer-only `close-research` action while a research workflow is in any active research, wiki drafting, or wiki approval step. The action SHALL directly transition the workflow to `core.closed`, expire any active agent run, and stop any launched session through the existing effect mechanism. Researcher output or ordinary agent handoff SHALL not close the workflow implicitly.

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

#### Scenario: Repeated close is safe
- **WHEN** `close-research` is dispatched after the workflow is already closed
- **THEN** the command is unavailable or idempotently reports the closed state
- **AND** no duplicate stop effect or lifecycle transition is created

### Requirement: Researcher follows evidence-oriented web research behavior
The dedicated researcher instructions SHALL require use of only tools and extensions exposed by the selected runtime/profile, without requiring a specific browser, search engine, MCP server, provider, or new dependency. Research launches SHALL NOT apply an application-level tool-name allowlist or denylist beyond the selected runtime's own default agent-launch semantics; the researcher's runtime SHALL expose the same built-in, extension, and custom tools it would expose to any other agent launched on that profile, so no operator-supplied tool or extension is dropped merely for lacking a matching name in a configuration list, and no built-in tool is withheld by a research-specific tool-name filter. When web or external sources are used, the researcher SHALL identify source URLs, distinguish sourced facts from synthesis, and disclose uncertainty or conflicting evidence. For repository-context research, configured tools and extensions are user-trusted integrations exposed exactly as they would be to any agent, while the workflow's source-isolation guard remains authoritative and repository mutations SHALL still be rejected or blocked before the research result is accepted.

#### Scenario: Runtime tool availability is respected
- **WHEN** a research runtime exposes any built-in, extension, or custom tool for the selected profile
- **THEN** the researcher may use that tool exactly as it would be available to any other agent launched on the same runtime/profile
- **AND** the workflow does not withhold the tool because its name is absent from an allowlist or matched by a research-specific tool restriction
- **AND** the workflow does not assume an unconfigured integration exists

#### Scenario: Configured research extensions are retained
- **WHEN** a user selects a research profile with configured runtime extensions that provide research tools
- **THEN** those extensions remain part of the research launch configuration for runtimes that support profile extensions
- **AND** the workflow does not silently remove them as a side effect of research read-only routing

#### Scenario: Mutating built-in tools remain available like any other agent
- **WHEN** the selected runtime/profile would normally expose file-editing or shell tools to an agent
- **THEN** the researcher launch also exposes those tools rather than filtering them out by name
- **AND** the read-only repository boundary and source-isolation validation, not tool-name gating, remain the mechanism that rejects or blocks an accepted repository mutation

#### Scenario: Research cites web evidence
- **WHEN** a response relies on web research
- **THEN** it identifies the relevant source URLs and labels conclusions that are synthesis rather than directly sourced facts

#### Scenario: Conflicting evidence is found
- **WHEN** credible sources disagree or evidence is incomplete
- **THEN** the researcher reports the conflict or uncertainty instead of presenting an unsupported conclusion as fact

#### Scenario: User-trusted integration mutates repository context
- **WHEN** a configured research tool or extension changes the supplied source repository
- **THEN** the workflow's source-isolation validation rejects or blocks the research result
- **AND** the source repository is not presented as unchanged or as a valid research result

### Requirement: Researcher may hand off to a reviewed wiki draft only on explicit request
During the active research stage, the researcher SHALL remain interactive until the user explicitly requests a wiki entry. The developer SHALL then dispatch the authenticated `request-research-wiki` action, which expires the researcher run and enters `core.wiki`; the dedicated wiki role searches, inspects, and writes centralized concepts. Wiki writing SHALL use the existing OKF v0.2 conventions, update an intended existing concept in place before creating a near-duplicate, use project-aware namespaces when repository context exists, and produce an unverified draft. The researcher and wiki agent SHALL not verify concepts or set human-reviewed metadata; a developer approves the draft in `core.wiki-approval`.

#### Scenario: No implicit wiki write
- **WHEN** the researcher completes a research answer without an explicit wiki-entry request
- **THEN** it does not hand off `complete`, and no wiki concept is written

#### Scenario: User requests a wiki draft
- **WHEN** the user explicitly asks for a wiki entry
- **THEN** the developer may dispatch the authenticated `request-research-wiki` action to enter `core.wiki`
- **AND** the authenticated wiki run may create or update a centralized OKF draft
- **AND** the workflow enters `core.wiki-approval` after wiki drafting for developer review

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
