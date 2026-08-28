# knowledge-wiki Specification

## Purpose
TBD - created by archiving change introduce-okf-wiki. Update Purpose after archive.

## Requirements

### Requirement: Centralized bundle location
The system SHALL store the knowledge bundle in a single machine-wide directory outside every repository, resolved with the precedence `HERDR_WIKI_DIR` environment variable, then the `[wiki] root` configuration key (tilde-expanded), then the default `~/.config/agentic-coding/wiki`.

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

### Requirement: Sequential planning roles author drafts
The system SHALL permit the `write` operation when `HERDR_ROLE` is unset or is a sequential planning role or the archive role, and SHALL reject it for any other role. For a non-archive role the system SHALL force `status` to `draft`, SHALL set `generated.by` from the writing role, and SHALL NOT write a `verified` field.

#### Scenario: Sequential planner writes a draft
- **WHEN** `write` runs with `HERDR_ROLE` set to the planner or consolidator role
- **THEN** the concept is installed with `status: draft`, a `generated.by` actor identifying that role, and no `verified` field

#### Scenario: Planner cannot self-verify
- **WHEN** a planner or consolidator write attempts to set `status: stable` or supply a `verified` value
- **THEN** the request is rejected or the value is forced back to a draft with no verification, and the stored concept remains unverified

#### Scenario: Parallel fusion planner may not write
- **WHEN** `write` runs with `HERDR_ROLE` set to a parallel fusion planner role
- **THEN** the operation exits non-zero with an error, and the bundle is unchanged

#### Scenario: Worker and verifier may not write
- **WHEN** `write` runs with `HERDR_ROLE` set to a worker, triage, or verifier role
- **THEN** the operation exits non-zero with an error, and the bundle is unchanged

#### Scenario: Human administration is permitted
- **WHEN** `write` runs with `HERDR_ROLE` unset
- **THEN** the concept is installed

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
The system SHALL provide a developer-actor workflow step for wiki approval, positioned after the archive step and before the delivery step in every workflow definition that includes an archive step, with the outcomes `approve` and `comments`. The approve outcome SHALL proceed to delivery and the comments outcome SHALL return to the archive step under a bounded loop. Definitions without an archive step SHALL NOT gain the gate.

#### Scenario: Approval proceeds to delivery
- **WHEN** the developer approves at the wiki approval gate
- **THEN** the workflow advances to the delivery step

#### Scenario: Comments return to the archive agent
- **WHEN** the developer submits comments at the wiki approval gate
- **THEN** the workflow returns to the archive step so the agent can revise

#### Scenario: Definitions without archive are unaffected
- **WHEN** a workflow definition has no archive step
- **THEN** it contains no wiki approval step

### Requirement: The archive agent survives the gate
No step between the archive step's completion and the resolution of the wiki approval gate SHALL be permitted to close or clean up the workspace, so the archive agent remains available to act on review comments. A comments outcome SHALL reuse the running archive agent rather than launching a replacement.

#### Scenario: No teardown before the gate resolves
- **WHEN** the workflow sits at the wiki approval gate
- **THEN** no step reached so far permits a workspace close or cleanup effect

#### Scenario: Revision reuses the live agent
- **WHEN** the gate returns the workflow to the archive step with comments
- **THEN** the still-running archive agent receives the work instead of a newly launched agent

### Requirement: Wiki review modal
The wiki approval gate SHALL open a review modal listing the concepts the change touched, each showing its change counts, and SHALL open a selected concept in a diff view of its snapshot against its current content. The user SHALL be able to anchor comments to lines or line ranges, finish the review, and postpone it without dispatching an action.

#### Scenario: Gate opens the concept list directly
- **WHEN** the workflow reaches the wiki approval gate
- **THEN** the wiki review popup opens with the touched-concept list rather than a generic action notice

#### Scenario: Open a concept diff
- **WHEN** the user selects a concept row
- **THEN** the concept opens in a diff view of the snapshot against the current content

#### Scenario: Comment on a line
- **WHEN** the user selects a line in the diff view and submits a comment
- **THEN** the comment is anchored to that line and rendered as a comment thread

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
The pinned instructions for the planning, fusion-planning, and fusion-consolidation steps SHALL direct the agent to consult the bundle before deciding, SHALL state that wiki access is exempt from the surrounding restrictions on exploration, and SHALL require the agent to weight a concept by its `status`, trust tier, and staleness rather than treating every concept as authoritative. The fusion-planning instruction SHALL forbid writing and require gaps to be reported in the draft's risks or questions.

#### Scenario: Planning instructions grant access
- **WHEN** the planning, fusion-planning, or fusion-consolidation instruction is rendered into an assignment
- **THEN** it instructs the agent to search and read the bundle and exempts that access from the scope restriction it would otherwise violate

#### Scenario: Trust signals are weighted
- **WHEN** a planning agent reads a concept
- **THEN** its instructions require treating an unverified draft, a deprecated concept, and a stale concept as weaker evidence than a verified stable one

#### Scenario: Parallel planners report gaps instead of writing
- **WHEN** a fusion planner identifies missing or stale knowledge
- **THEN** its instructions require reporting the gap in its own draft's risks or questions and prohibit invoking any wiki write operation

#### Scenario: Sequential planning roles may draft
- **WHEN** the planning or fusion-consolidation agent identifies knowledge worth capturing
- **THEN** its instructions permit writing it as a draft concept and state that the archive role is what promotes a draft to verified

### Requirement: Archive role writes the wiki
The pinned archive instruction SHALL direct the agent, after a successful OpenSpec archive, to record durable cross-change knowledge from the landed change, to promote the drafts written during planning for that change, to update an existing concept in place rather than creating a near-duplicate, to mark a superseded concept deprecated rather than deleting it, to append a `log.md` entry, to list the touched concept identifiers in the run-bound archive evidence, and to state explicitly when a change produced no knowledge worth recording. The instruction SHALL additionally direct the agent, when the gate returns the workflow with review comments, to read those comments from the run context, apply each to the concept it names, and record which comment each edit resolves.

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

### Requirement: Non-planning roles have no wiki exposure
The pinned instructions for the implementation, triage, and verification steps SHALL NOT reference the wiki, and wiki guidance SHALL NOT be added to any instruction asset shared with those steps.

#### Scenario: Worker and verifier prompts stay wiki-free
- **WHEN** the implementation, triage, or verification instructions are rendered into an assignment
- **THEN** no wiki command or wiki guidance appears in the assignment

### Requirement: Instruction pins stay consistent
The embedded agent-definition bundle SHALL be regenerated whenever an instruction asset changes, so each step's pinned instruction digest matches the on-disk asset content.

#### Scenario: Changed instruction digests match on disk
- **WHEN** the embedded digest of a changed instruction asset is compared to the hash of its on-disk file
- **THEN** the two are equal
