# knowledge-wiki Specification

## Purpose
TBD - created by archiving change introduce-okf-wiki. Update Purpose after archive.
## Requirements
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

### Requirement: OKF bundle initialization
The system SHALL create the bundle on first use as an Open Knowledge Format v0.2 bundle, consisting of the root directory and a bundle-root `index.md` whose frontmatter declares `okf_version: "0.2"`. The system SHALL NOT create a separate manifest file. Initialization SHALL be idempotent and SHALL NOT overwrite an existing root `index.md`.

#### Scenario: First use creates a conformant bundle root
- **WHEN** a wiki operation runs against a bundle root that does not exist
- **THEN** the root directory and a root `index.md` carrying `okf_version: "0.2"` in its frontmatter are created

#### Scenario: Initialization is idempotent
- **WHEN** initialization runs against a bundle root that already has a root `index.md`
- **THEN** the existing file is left unchanged and no error is raised

### Requirement: Concept documents follow OKF v0.2
The system SHALL represent each unit of knowledge as one UTF-8 markdown concept document with a YAML frontmatter block delimited by `---`, where the concept identifier is the document's bundle-relative path with the `.md` suffix removed. Frontmatter SHALL carry a non-empty `type`. Documents written by the system SHALL additionally carry `title` and `description`, and MAY carry `resource`, `tags`, `sources`, `generated`, `verified`, `status`, and `stale_after` as defined by the specification. Relationships between concepts SHALL be expressed as ordinary markdown links, not as a frontmatter field.

#### Scenario: Concept identifier derives from the path
- **WHEN** a concept is stored at `conventions/biome-formatting.md` within the bundle
- **THEN** its concept identifier is `conventions/biome-formatting` and no `id` frontmatter field is required

#### Scenario: Written concept carries producer fields
- **WHEN** the system writes a concept
- **THEN** the resulting frontmatter contains a non-empty `type`, a `title`, a `description`, and a `generated` mapping with a `by` actor and an `at` timestamp

#### Scenario: Relationships use markdown links
- **WHEN** one concept references another
- **THEN** the reference is a markdown link to the other concept's bundle-relative path, and no relationship field is written to frontmatter

### Requirement: Permissive consumer behaviour
When reading the bundle, the system SHALL reject a concept document only when its frontmatter is unparseable or its `type` field is absent or empty. The system SHALL NOT reject a concept for a missing optional field, an unrecognized `type` value, unrecognized additional frontmatter keys, a broken cross-link, or a missing `index.md`. Unrecognized frontmatter keys SHALL be preserved when a document is read and written back.

#### Scenario: Unknown type is accepted
- **WHEN** a concept declares a `type` value the system has never seen
- **THEN** the concept is read and returned normally

#### Scenario: Unknown extra keys are accepted and preserved
- **WHEN** a concept carries additional frontmatter keys defined by another producer
- **THEN** reading succeeds, and writing the concept back retains those keys with their values

#### Scenario: Minimal concept is accepted
- **WHEN** a concept's frontmatter contains only a `type` field
- **THEN** the concept is read and returned normally

#### Scenario: Broken link does not fail a read
- **WHEN** a concept links to a bundle path that does not exist
- **THEN** the read succeeds and the missing target is not treated as an error

#### Scenario: Missing type is rejected
- **WHEN** a concept's frontmatter omits `type` or sets it to an empty value
- **THEN** reading that concept reports a non-conformance error naming the document

#### Scenario: Unparseable frontmatter is rejected
- **WHEN** a concept's frontmatter block is not parseable YAML
- **THEN** reading that concept reports a parse error naming the document

### Requirement: Frontmatter parsing and rendering
The system SHALL parse frontmatter with a parser that accepts the full YAML used by the specification, including nested mappings and lists of mappings, without adding a third-party dependency. The system SHALL render frontmatter it writes in block style so that each field occupies its own line and changes produce line-level diffs.

#### Scenario: Nested frontmatter families parse
- **WHEN** a concept carries `generated: { by, at }`, a `verified` list of mappings, and a `sources` list of mappings with credibility signals
- **THEN** all fields parse into their structured values

#### Scenario: Bare verified mapping is treated as a single-element list
- **WHEN** a concept carries `verified` as a single mapping rather than a list
- **THEN** the system treats it as a list containing that one verification event

#### Scenario: Rendered frontmatter is block style
- **WHEN** the system writes a concept with multiple frontmatter fields
- **THEN** the rendered frontmatter places each top-level field on its own line rather than emitting a single flow-style line

#### Scenario: Round-trip preserves content
- **WHEN** a concept produced by another OKF producer is read and written back unchanged
- **THEN** re-parsing the result yields the same field values, including keys the system does not recognize

### Requirement: Concept path safety
The system SHALL accept only bundle-relative concept paths whose resolved location remains inside the bundle root, and SHALL refuse to treat the reserved filenames `index.md` and `log.md` as concept documents.

#### Scenario: Traversal path is rejected
- **WHEN** an operation is given a concept path containing `..` or an absolute path outside the bundle
- **THEN** the operation fails with an error and no location outside the bundle root is accessed

#### Scenario: Reserved filename is rejected as a concept
- **WHEN** an operation targets `index.md` or `log.md` as a concept document
- **THEN** the operation fails with an error naming the reserved filename

### Requirement: Bundle read operations
The system SHALL provide `list`, `search`, and `show` operations. `list` SHALL synthesize a directory listing of the bundle at read time rather than reading or maintaining a stored index, and SHALL support filtering by tag and by type. `search` SHALL rank matching concepts across title, tags, headings, and body, honour a result limit, and include each hit's concept identifier, title, tags, `status`, trust tier, and staleness. `show` SHALL return the full concept for an identifier. All read operations SHALL be available without any role restriction.

#### Scenario: List synthesizes without a stored index
- **WHEN** `list` runs against a bundle containing no `index.md` below the root
- **THEN** the listing is produced from the concept documents themselves and no index file is written

#### Scenario: Search ranks a title match above a body match
- **WHEN** one concept matches a search term in its title and another matches only in its body
- **THEN** the title match is ordered before the body match

#### Scenario: Search honours the result limit
- **WHEN** a search matches more concepts than the requested limit
- **THEN** at most the requested number of results is returned

#### Scenario: Search results expose trust and lifecycle
- **WHEN** results include an unverified draft, a verified stable concept, and a concept whose `stale_after` has passed
- **THEN** each result reports its `status`, its trust tier, and whether it is stale

#### Scenario: List filters by tag
- **WHEN** `list` is invoked with a tag filter
- **THEN** only concepts carrying that tag are returned

#### Scenario: Show of an unknown concept fails clearly
- **WHEN** `show` is invoked with an identifier that has no concept
- **THEN** the operation exits non-zero with an error naming the identifier

#### Scenario: Reads work without a managed role
- **WHEN** `list`, `search`, or `show` runs with `HERDR_ROLE` unset
- **THEN** the operation succeeds

### Requirement: Trust tiers derive from verification
The system SHALL derive a concept's trust tier from its `verified` field: absent `verified` yields unverified, `verified` by non-human actors only yields machine-confirmed, and `verified` by an actor using the `human:` prefix yields human-reviewed. Actor strings SHALL follow the `<producer>/<version>`, `human:<id>`, and `process:<id>` conventions. The system SHALL refuse to write an actor using the `human:` prefix from any invocation made by a managed agent role.

#### Scenario: Draft concept is unverified
- **WHEN** a concept has no `verified` key
- **THEN** its trust tier is unverified

#### Scenario: Process verification is machine-confirmed
- **WHEN** a concept's only verification event has a `by` actor of `process:herdr-archive`
- **THEN** its trust tier is machine-confirmed

#### Scenario: Human verification is human-reviewed
- **WHEN** a concept carries a verification event whose `by` actor begins with `human:`
- **THEN** its trust tier is human-reviewed

#### Scenario: An agent cannot forge a human actor
- **WHEN** a wiki write or verify runs with a managed agent role set and supplies an actor beginning with `human:`
- **THEN** the operation exits non-zero and the concept is not given a human verification event

### Requirement: Lifecycle status and staleness
The system SHALL support `status` values `draft`, `stable`, and `deprecated`, SHALL treat an absent `status` as `stable`, and SHALL treat a concept as stale when the current instant is at or after its `stale_after` value. Timestamps SHALL be ISO 8601 datetimes with an explicit UTC offset.

#### Scenario: Absent status defaults to stable
- **WHEN** a concept carries no `status` field
- **THEN** it is reported as `stable`

#### Scenario: Staleness is an instant comparison
- **WHEN** a concept's `stale_after` instant is in the past
- **THEN** the concept is reported as stale

#### Scenario: Invalid status is rejected on write
- **WHEN** a write specifies a `status` outside `draft`, `stable`, and `deprecated`
- **THEN** the write fails with an error naming the invalid value

### Requirement: Atomic concept writes
The system SHALL validate producer requirements before writing a concept and SHALL install it by writing a temporary file in the target directory and renaming it into place, so a rejected or interrupted write never leaves a partial or non-conformant document in the bundle. Writing an existing concept path SHALL replace that document in place rather than creating a duplicate.

#### Scenario: Rejected write leaves the bundle untouched
- **WHEN** a write is attempted without a required producer field
- **THEN** the operation fails and no new or partial file exists in the bundle

#### Scenario: Existing concept is updated in place
- **WHEN** a write targets a concept path that already exists
- **THEN** the existing document is replaced, its `generated.at` reflects the write, and no second document is created for the same path

#### Scenario: Provenance is recorded
- **WHEN** a concept is written with an originating change identifier
- **THEN** a `sources` entry naming that change is present, and every `sources` entry carries a `resource`

### Requirement: Archive promotes and records history
The system SHALL provide `verify` and `log` operations restricted to the archive role or an unset `HERDR_ROLE`. `verify` SHALL append a verification event with a `process:herdr-archive` actor and the current timestamp, and SHALL set `status` to `stable`. `log` SHALL append an entry to a `log.md` file under an ISO `YYYY-MM-DD` date heading, newest first.

#### Scenario: Archive promotes a draft
- **WHEN** `verify` runs with `HERDR_ROLE` set to `archive` against a draft concept
- **THEN** the concept's `status` becomes `stable` and a verification event with a `process:herdr-archive` actor is appended

#### Scenario: Verification is repeatable
- **WHEN** `verify` runs twice against the same concept
- **THEN** the second run succeeds without corrupting the document and the concept remains stable and verified

#### Scenario: Non-archive role may not verify
- **WHEN** `verify` or `log` runs with `HERDR_ROLE` set to a planner, consolidator, worker, or verifier role
- **THEN** the operation exits non-zero and the bundle is unchanged

#### Scenario: Log entries group by date, newest first
- **WHEN** entries are appended on two different dates
- **THEN** `log.md` contains an ISO `YYYY-MM-DD` heading per date with the most recent date first

### Requirement: Change snapshot records the pre-change state
The first time a run belonging to a change modifies a concept, the system SHALL copy that concept's prior content into a per-change snapshot, recording a tombstone when the concept did not previously exist, and SHALL NOT overwrite an existing snapshot entry on subsequent writes within the same change. The snapshot SHALL serve as both the diff basis for review and the authoritative list of concepts the change touched.

#### Scenario: First touch captures the prior document
- **WHEN** a change modifies an existing concept for the first time
- **THEN** the concept's prior content is stored in the change's snapshot

#### Scenario: New concept records a tombstone
- **WHEN** a change creates a concept that did not previously exist
- **THEN** the snapshot records that the concept was absent before the change

#### Scenario: Later writes preserve the original snapshot
- **WHEN** the same change modifies the same concept a second time
- **THEN** the snapshot still holds the state from before the change's first modification

#### Scenario: Snapshot yields the touched-concept list
- **WHEN** a change has modified several concepts
- **THEN** the snapshot enumerates exactly those concepts

### Requirement: Wiki approval gate precedes delivery
The system SHALL provide a developer-actor workflow step for wiki approval, positioned after the dedicated wiki documentation step. In every workflow definition that includes an archive step, the wiki documentation and approval steps SHALL precede the OpenSpec archive and delivery steps according to that definition's configured ordering. A definition without an archive step SHALL remain free of these steps unless it is explicitly the archive-free `wiki-only` workflow, whose purpose is documentation and whose approval advances directly to completion. The gate SHALL have the outcomes `approve` and `comments`. The approve outcome SHALL enqueue the engine-owned human-verification effect when the workflow has touched concepts and proceed to the definition's configured next step; the comments outcome SHALL return to the documentation step for `wiki-only` and for archive-before-approval definitions, or to the archive step for archive-after-approval definitions, under a bounded loop.

#### Scenario: Documentation precedes review and archive
- **WHEN** an archive-bearing workflow is registered
- **THEN** its reachable path contains the wiki documentation step, wiki approval gate, archive step, and delivery step in the configured order

#### Scenario: Approval promotes before archive
- **WHEN** the developer approves at the wiki approval gate in an archive-bearing workflow
- **THEN** the engine promotes every touched concept through its human-verification effect and advances to the configured archive or delivery path

#### Scenario: Comments return to documentation before archive
- **WHEN** the developer submits comments at the wiki approval gate positioned before archive
- **THEN** the workflow returns to the dedicated wiki documentation step so the agent can revise the documentation

#### Scenario: Comments return to archive after archive
- **WHEN** the developer submits comments at the wiki approval gate positioned after archive
- **THEN** the workflow returns to the archive step so the archive agent can revise

#### Scenario: Definitions without archive are unaffected
- **WHEN** a workflow definition has no archive step and is not explicitly `wiki-only`
- **THEN** it contains neither the wiki documentation step nor the wiki approval step

#### Scenario: Wiki-only approval completes directly
- **WHEN** the developer approves at the wiki approval gate for `wiki-only`
- **THEN** the engine promotes the touched concepts through its human-verification effect and advances directly to `core.completed`
- **AND** it SHALL not enqueue archive, delivery, or pull-request effects

#### Scenario: Wiki-only comments return to documentation
- **WHEN** the developer submits comments at the wiki approval gate for `wiki-only`
- **THEN** the workflow returns to `core.wiki` under its bounded review loop

### Requirement: The archive agent survives the gate
No step between the archive step's completion and the resolution of the wiki approval gate SHALL be permitted to close or clean up the workspace, so the archive agent remains available to act on review comments. A comments outcome SHALL reuse the running archive agent rather than launching a replacement.

#### Scenario: No teardown before the gate resolves
- **WHEN** the workflow sits at the wiki approval gate
- **THEN** no step reached so far permits a workspace close or cleanup effect

#### Scenario: Revision reuses the live agent
- **WHEN** the gate returns the workflow to the archive step with comments
- **THEN** the still-running archive agent receives the work instead of a newly launched agent

### Requirement: Wiki review modal
The wiki approval gate SHALL open a review modal listing the concepts the change touched, each showing its change counts, and SHALL open a selected concept in a real diff view comparing its pre-change snapshot with its current content. The diff view SHALL use the same selectable unified/split review presentation and established color semantics as developer review: added content is visibly green, removed content is visibly red, and unchanged context remains distinguishable. The user SHALL be able to navigate the changed lines, anchor comments to current-document lines or line ranges, finish the review, and postpone it without dispatching an action.

#### Scenario: Gate opens the concept list directly
- **WHEN** the workflow reaches the wiki approval gate
- **THEN** the wiki review popup opens with the touched-concept list rather than a generic action notice

#### Scenario: Open a concept diff
- **WHEN** the user selects a concept row
- **THEN** the concept opens in a diff view comparing the snapshot (before) against the current (after) content, with the concept's change counts and file navigation context preserved

#### Scenario: Added and removed content is color coded
- **WHEN** the snapshot and current concept differ
- **THEN** added lines are rendered with the developer-review green styling, removed lines with the developer-review red styling, and context lines with the normal diff styling

#### Scenario: New and deleted concepts remain reviewable
- **WHEN** a touched concept exists only in the current bundle or only in the snapshot
- **THEN** the diff view shows all current-only lines as additions or all snapshot-only lines as removals, respectively, without crashing or presenting the concept as unchanged

#### Scenario: Comment on a line
- **WHEN** the user selects a current-document line in the diff view and submits a comment
- **THEN** the comment is anchored to that current concept line and rendered as a comment thread

#### Scenario: Snapshot-only lines are not commentable
- **WHEN** the user selects a removed snapshot line or snapshot-only context in the diff view and attempts to comment
- **THEN** the review prevents a writable comment anchor and explains that only current-document content is commentable

#### Scenario: Postpone the review
- **WHEN** the user dismisses the wiki review popup
- **THEN** the popup closes without dispatching any workflow action

#### Scenario: Finish with comments requests changes
- **WHEN** the user finishes the review and comments exist
- **THEN** the comments are persisted for the change and the comments action is dispatched

#### Scenario: Finish without comments approves
- **WHEN** the user finishes the review and no comments exist
- **THEN** the approval action is dispatched

### Requirement: Approval grants the human-reviewed tier
Approving the wiki approval gate SHALL promote every concept in the change's snapshot list by appending a verification event whose actor uses the `human:` prefix, and this promotion SHALL be performed by the workflow engine rather than by any agent. The reviewer identity SHALL resolve from configuration, then the repository's configured git user identity, then a generic fallback.

#### Scenario: Approval promotes every touched concept
- **WHEN** the developer approves at the wiki approval gate
- **THEN** each concept in the change's snapshot list gains a verification event with a `human:` actor and reports the human-reviewed trust tier

#### Scenario: Untouched concepts are not promoted
- **WHEN** the developer approves at the wiki approval gate
- **THEN** concepts outside the change's snapshot list are left unchanged

#### Scenario: Promotion is engine-performed
- **WHEN** the approval promotion runs
- **THEN** it is executed as a workflow effect on the approval transition and not by the archive agent

#### Scenario: Reviewer identity falls back
- **WHEN** no reviewer is configured and no git user identity is available
- **THEN** a generic human actor is recorded rather than failing the approval

#### Scenario: Comments do not promote
- **WHEN** the developer submits comments instead of approving
- **THEN** no concept gains a human verification event

### Requirement: Wiki command surface
The system SHALL expose the bundle through the `wiki` subcommand of the workflow CLI with the operations `list`, `search`, `show`, `write`, `verify`, and `log`, include it in the CLI help text, and reject an unknown operation or a missing required argument with a non-zero exit and a usage message. Wiki operations SHALL NOT require a repository, a change identifier, or workflow state.

#### Scenario: Unknown operation is rejected
- **WHEN** the wiki subcommand is invoked with an operation outside the defined set
- **THEN** the command exits non-zero with a usage message listing the valid operations

#### Scenario: Missing required argument is rejected
- **WHEN** a wiki operation is invoked without a required argument
- **THEN** the command exits non-zero with a usage message

#### Scenario: Operates outside a workflow
- **WHEN** a wiki operation runs without repository or change flags and with no workflow state present
- **THEN** the operation succeeds

### Requirement: Planning roles consult the wiki
The pinned instructions for the planning, fusion-planning, and fusion-consolidation steps SHALL direct the agent to consult the bundle before deciding, SHALL state that wiki access is exempt from the surrounding restrictions on exploration, and SHALL require the agent to weight a concept by its `status`, trust tier, and staleness rather than treating every concept as authoritative. The instructions SHALL require project-specific knowledge to use `projects/<project-id>/<concept>`, genuinely cross-project knowledge to use `shared/<concept>` only when evidence from each covered project is available, and repository-relative source paths to be interpreted in the context of the project whose concept is being documented rather than presented as universal facts. Planning, fusion-planning, and fusion-consolidation agents SHALL NOT write wiki concepts; they SHALL report useful documentation gaps in their planning output for the dedicated wiki documentation step.

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
- **WHEN** a planning or consolidation agent identifies missing or stale knowledge
- **THEN** it reports the gap in its plan risks or questions and does not invoke a wiki write operation

#### Scenario: Sequential planning roles may draft
- **WHEN** a sequential planning or consolidation agent identifies knowledge worth capturing
- **THEN** it leaves the documentation to the dedicated wiki role rather than writing a draft concept

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

### Requirement: Instruction pins stay consistent
The embedded agent-definition bundle SHALL be regenerated whenever an instruction asset changes, so each step's pinned instruction digest matches the on-disk asset content.

#### Scenario: Changed instruction digests match on disk
- **WHEN** the embedded digest of a changed instruction asset is compared to the hash of its on-disk file
- **THEN** the two are equal

### Requirement: Human review preserves the documentation agent's work
No step between the wiki documentation step's completion and the resolution of the wiki approval gate SHALL close or clean up the workspace. A comments outcome SHALL launch or resume the dedicated wiki role with the review context rather than routing to the archive role, and the documentation step SHALL revise wiki concepts without repeating any OpenSpec archival operation.

#### Scenario: No teardown before the gate resolves
- **WHEN** the workflow sits at the wiki approval gate
- **THEN** no step reached so far permits a workspace close or cleanup effect

#### Scenario: Revision receives review context
- **WHEN** the gate returns the workflow to the wiki documentation step with comments
- **THEN** the wiki role receives the bounded comments and their concept or line anchors as revision context

#### Scenario: Revision does not archive
- **WHEN** the wiki documentation step runs after review comments
- **THEN** it edits only the affected documentation and does not run the OpenSpec archive operation

### Requirement: Dedicated wiki role authors OKF drafts
The system SHALL provide a dedicated agent step and role for documentation in archive-bearing workflows. The wiki role SHALL inspect the change's available repository evidence and the centralized bundle, then write or update meaningful OKF v0.2 concept documents as unverified drafts using project-scoped identifiers, preserving unknown frontmatter fields and updating an existing concept in place rather than creating an active near-duplicate. Each authored concept SHALL include a non-empty type, title, description, source resources, and body content that explains durable facts with repository-relative citations qualified by project context. The role SHALL report the touched concept identifiers, or explicitly report that no durable knowledge was found, in its run-bound evidence.

#### Scenario: Wiki role writes a draft concept
- **WHEN** the dedicated wiki step identifies durable project knowledge
- **THEN** it writes or updates a concept under `projects/<project-id>/` with `status: draft`, generated provenance, sources, and no `verified` event

#### Scenario: Wiki role avoids duplicate concepts
- **WHEN** a related concept already exists in the centralized bundle
- **THEN** the wiki role updates the intended existing identifier after searching and reading candidates instead of creating an active near-duplicate

#### Scenario: Wiki role records no-op documentation
- **WHEN** the change contains no durable knowledge worth retaining
- **THEN** the wiki role writes no concept and its evidence explicitly states that no durable knowledge was found

#### Scenario: Draft content follows OKF shape
- **WHEN** a concept is authored by the wiki role
- **THEN** it is a valid UTF-8 Markdown concept with OKF v0.2-compatible frontmatter and meaningful body-level claims tied to source resources

### Requirement: Wiki authoring is isolated to the dedicated role
Managed workflow invocations SHALL permit wiki draft writes for the dedicated `wiki` role and SHALL reject wiki draft writes from planner, consolidator, fusion-planner, worker, triage, verifier, and archive roles. The dedicated role SHALL NOT be able to set a stable status or supply a machine or human verification event. The existing administrative `wiki verify` operation MAY set `status: stable` with a `process:herdr-archive` machine verification event, but SHALL reject human or arbitrary actors. Human-reviewed promotion SHALL remain an engine-owned effect of developer approval.

#### Scenario: Dedicated role is permitted to write
- **WHEN** `wiki write` runs with the managed `wiki` role
- **THEN** the concept is installed as an unverified draft

#### Scenario: Planning and archive roles cannot write
- **WHEN** `wiki write` runs with a managed planner, consolidator, or archive role
- **THEN** the operation exits non-zero and the bundle remains unchanged

#### Scenario: Other implementation roles cannot write
- **WHEN** `wiki write` runs with a managed worker, triage, verifier, or fusion-planner role
- **THEN** the operation exits non-zero and the bundle remains unchanged

#### Scenario: Wiki role cannot self-verify
- **WHEN** the dedicated wiki role attempts to set stable status or provide a verification actor
- **THEN** the operation rejects the request or stores only a draft without verification

#### Scenario: Administrative process verification remains machine-confirmed
- **WHEN** an unmanaged administrator or archive role invokes `wiki verify` with a `process:` actor
- **THEN** the operation records that process verification and sets `status: stable` with machine-confirmed trust, without granting human-reviewed trust

#### Scenario: Human approval grants human-reviewed trust
- **WHEN** the developer approves the reviewed wiki content
- **THEN** the engine-owned `wiki.verify` effect adds the human verification event and leaves the concept `status: stable` with human-reviewed trust

### Requirement: Wiki review comments are applied by the wiki role
When the developer review gate returns comments, the workflow SHALL expose the bounded comments and any line or concept anchors to the next wiki documentation run. The wiki role SHALL read the named concepts, apply each valid comment without discarding unrelated content, and record which comments were resolved. A comment that is invalid or already satisfied SHALL be called out explicitly, and the wiki role SHALL not perform archival or human verification itself.

#### Scenario: Comments identify a concept edit
- **WHEN** a review comment names a concept and an anchored line
- **THEN** the next wiki run updates that concept and records the comment as resolved

#### Scenario: Invalid comment is reported
- **WHEN** a review comment cannot be applied to the current concept
- **THEN** the wiki run reports it as invalid or already satisfied instead of silently ignoring it

#### Scenario: Revision remains unverified
- **WHEN** the wiki role completes a comment-driven revision
- **THEN** touched concepts remain drafts without a human verification event until the developer approves again

