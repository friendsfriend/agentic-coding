## MODIFIED Requirements

### Requirement: Centralized bundle location
The system SHALL store the knowledge bundle in a single machine-wide directory outside every repository, resolved with the precedence `HERDR_WIKI_DIR` environment variable, then the `[wiki] root` configuration key (tilde-expanded), then the default `~/.config/agentic-coding/wiki`. The centralized bundle SHALL support concepts from multiple projects; OKF SHALL NOT be treated as requiring one repository per bundle, and the system SHALL NOT automatically federate multiple bundle roots.

#### Scenario: Environment override wins
- **WHEN** `HERDR_WIKI_DIR` is set and a `[wiki] root` key is also configured
- **THEN** the resolved bundle root is the `HERDR_WIKI_DIR` value

#### Scenario: Configuration key used when no environment override
- **WHEN** `HERDR_WIKI_DIR` is unset and `[wiki] root` is configured
- **THEN** the resolved bundle root is the configured value with a leading `~` expanded to the user's home directory

#### Scenario: Default when nothing is configured
- **WHEN** neither `HERDR_WIKI_DIR` nor `[wiki] root` is set
- **THEN** the resolved bundle root is `~/.config/agentic-coding/wiki`

#### Scenario: Bundle is shared across projects
- **WHEN** a wiki read is performed from two different repositories with the same resolution inputs
- **THEN** both reads resolve to the same bundle root and observe the same concepts

#### Scenario: No repository-specific bundle is implied
- **WHEN** a project uses the default or explicitly resolved wiki root
- **THEN** the root remains one centralized bundle and no additional project root is created or implicitly federated

### Requirement: Planning roles consult the wiki
The pinned instructions for the planning, fusion-planning, and fusion-consolidation steps SHALL direct the agent to consult the bundle before deciding, SHALL state that wiki access is exempt from the surrounding restrictions on exploration, and SHALL require the agent to weight a concept by its `status`, trust tier, and staleness rather than treating every concept as authoritative. The instructions SHALL require project-specific knowledge to use `projects/<project-id>/<concept>`, genuinely cross-project knowledge to use `shared/<concept>`, and repository-relative source paths to be interpreted in the context of the project whose concept is being documented rather than presented as universal facts. The fusion-planning instruction SHALL forbid writing and require gaps to be reported in the draft's risks or questions.

#### Scenario: Planning instructions grant access
- **WHEN** the planning, fusion-planning, or fusion-consolidation instruction is rendered into an assignment
- **THEN** it instructs the agent to search and read the bundle and exempts that access from the scope restriction it would otherwise violate

#### Scenario: Trust signals are weighted
- **WHEN** a planning agent reads a concept
- **THEN** its instructions require treating an unverified draft, a deprecated concept, and a stale concept as weaker evidence than a verified stable one

#### Scenario: Namespace is selected from scope
- **WHEN** a planning role records or proposes knowledge specific to one project
- **THEN** its instructions direct it to use `projects/<project-id>/<concept>`, while a fact applying across multiple projects uses `shared/<concept>` only when evidence from each covered project is available

#### Scenario: Repository paths retain project context
- **WHEN** a concept cites a repository-relative path
- **THEN** the instructions require identifying the project context for that path and prohibit presenting the path as a universal location or rule

#### Scenario: Parallel planners report gaps instead of writing
- **WHEN** a fusion planner identifies missing or stale knowledge
- **THEN** its instructions require reporting the gap in its own draft's risks or questions and prohibit invoking any wiki write operation

#### Scenario: Sequential planning roles may draft
- **WHEN** the planning or fusion-consolidation agent identifies knowledge worth capturing
- **THEN** its instructions permit writing it as a draft concept and state that the archive role is what promotes a draft to verified

### Requirement: Archive role writes the wiki
The pinned archive instruction SHALL direct the agent, after a successful OpenSpec archive, to record durable cross-change knowledge from the landed change, to promote the drafts written during planning for that change, to update an existing concept in place rather than creating a near-duplicate, to mark a superseded concept deprecated rather than deleting it, to append a `log.md` entry, to list the touched concept identifiers in the run-bound archive evidence, and to state explicitly when a change produced no knowledge worth recording. The instruction SHALL require project-specific concepts to use `projects/<project-id>/<concept>`, shared concepts to use `shared/<concept>` only when their claims are evidenced by every covered project, and repository-relative source paths to be labeled with the project context. When migrating legacy `repository/*` concepts, the instruction SHALL move them to the corresponding project-scoped identifiers when a safe move is available; otherwise it SHALL leave the legacy documents explicitly deprecated and ensure only one active project-scoped concept remains. The instruction SHALL additionally direct the agent, when the gate returns the workflow with review comments, to read those comments from the run context, apply each to the concept it names, and record which comment each edit resolves.

#### Scenario: Archive promotes after a successful archive
- **WHEN** the archive step completes `openspec archive` successfully
- **THEN** its instructions require verifying the change's draft concepts and appending a log entry before handing off

#### Scenario: Superseded knowledge is deprecated, not deleted
- **WHEN** a landed change makes an existing concept obsolete
- **THEN** the archive instruction requires marking it `status: deprecated` rather than removing the document

#### Scenario: Review comments are applied on revision
- **WHEN** the wiki approval gate returns the workflow to the archive step with comments
- **THEN** the instruction requires reading the comments from the run context, applying each to the named concept, and stating which comment each edit resolves

#### Scenario: Archive does not re-archive on revision
- **WHEN** the archive step runs again after gate comments on an already-archived change
- **THEN** the instruction requires revising the wiki without repeating the OpenSpec archive

#### Scenario: Wiki failure does not block the archive
- **WHEN** a wiki write fails after the change has already been archived
- **THEN** the archive reports the exact wiki error in its evidence rather than reporting a blocked outcome

#### Scenario: No durable knowledge is stated explicitly
- **WHEN** a change produces no knowledge worth recording
- **THEN** the archive evidence states that no concept was written

#### Scenario: Shared claims have complete project evidence
- **WHEN** the archive records a concept under `shared/<concept>` covering multiple projects
- **THEN** its evidence identifies source resources from each covered project and does not rely on a path from one repository as a universal fact

#### Scenario: Legacy concepts are migrated without active duplicates
- **WHEN** a legacy `repository/<concept>` draft corresponds to Agentic Coding project knowledge
- **THEN** the archive moves it to `projects/agentic-coding/<concept>` with its required frontmatter, sources, body citations, and `status: draft` unchanged, or marks the legacy document `status: deprecated` when a safe move is unavailable, while retaining only the project-scoped document as active

## ADDED Requirements

### Requirement: Concept namespaces express scope
The system SHALL use bundle-relative concept identifiers under `projects/<project-id>/<concept>` for facts specific to one project or repository and under `shared/<concept>` only for facts that apply across multiple projects. The system SHALL keep the existing centralized bundle and CLI operations; namespace scope SHALL be expressed by concept identifiers, source resources, tags, and Markdown guidance rather than requiring a new wiki frontmatter `project` field or CLI flag.

#### Scenario: Project concept uses a project namespace
- **WHEN** a concept documents implementation, workflow, or operational facts belonging to one project
- **THEN** its identifier begins with `projects/<project-id>/` and its repository-relative citations are interpreted relative to that project

#### Scenario: Shared concept requires cross-project scope
- **WHEN** a concept asserts a rule or fact that applies across more than one project
- **THEN** its identifier begins with `shared/` and its sources or body identify the projects supporting the claim

#### Scenario: Single-project evidence does not create shared knowledge
- **WHEN** all evidence for a claim comes from one repository or project
- **THEN** the claim is recorded under that project's namespace and is not presented as a `shared/` concept

#### Scenario: Existing concept is updated in place
- **WHEN** a concept with the intended scoped identifier already exists
- **THEN** the writer updates that identifier rather than creating a duplicate active concept or alias

#### Scenario: CLI surface remains unchanged
- **WHEN** a user reads or writes a scoped concept identifier through the existing wiki CLI operations
- **THEN** the operations and root-resolution precedence remain the same and the identifier is handled as an ordinary bundle-relative concept path

### Requirement: Legacy repository concepts have a bounded migration path
The existing Agentic Coding concepts under `repository/*` SHALL be treated as legacy project-scoped drafts. They SHALL be migrated to the corresponding `projects/agentic-coding/*` identifiers without adding human or machine verification; if a safe move cannot be performed, each legacy document SHALL be retained only as an explicitly deprecated record and SHALL NOT compete with an active project-scoped replacement.

#### Scenario: Eight Agentic Coding concepts map to project scope
- **WHEN** the legacy seed set is migrated
- **THEN** `repository/architecture`, `repository/workflow-lifecycle`, `repository/agent-roles`, `repository/testing-and-validation`, `repository/configuration`, `repository/dashboard`, `repository/runtime-adapters`, and `repository/telemetry` map to the same suffix beneath `projects/agentic-coding/`

#### Scenario: Migration preserves draft provenance
- **WHEN** a legacy concept is moved or replaced
- **THEN** its required frontmatter, `sources` entries, body repository citations, and `status: draft` are retained, no `verified` event is added, and the resulting project-scoped concept remains unverified

#### Scenario: Unmovable legacy record is explicit
- **WHEN** a legacy concept cannot be safely moved without losing data or breaking a supported reference
- **THEN** the legacy identifier remains readable with `status: deprecated`, its replacement is the sole active project-scoped concept, and the archive evidence names the reason
