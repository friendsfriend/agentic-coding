# stage-data-blocks Specification

## Purpose
TBD - created by archiving change author-stage-blocks-as-data. Update Purpose after archive.
## Requirements
### Requirement: Blocks may be authored as declarative data
The system SHALL accept a stage block as a JSON document (`format: 1`) that
declares the same identity and contract fields as a checked-in block (`id`,
semantic `version`, `title`, `description`, application scope, role list, effect
set, idempotency, `requires`/`provides`, parameter schema, return schema, at
least one example and a `postcondition`) plus an ordered `operations` list. The
operation list SHALL be a closed union of `step`, `optional`, `goto`, `click`,
`fill`, `type`, `press`, `select`, `waitFor`, `wait`, `expectVisible`,
`expectText`, `capture` and `read`, and every operation SHALL target the page
through the closed target union `{ role, name?, exact? }`, `{ label }`,
`{ testId }`, `{ text, exact? }` or `{ selector }`. A `value` SHALL be a bounded
string or a `{ secret: "<name>" }` reference; a string MAY interpolate a declared
parameter with `{{ args.<name> }}` and SHALL NOT contain any other expression. A
document SHALL NOT contain code, a function, an expression, a condition, a loop,
a raw URL, a credential value or an unknown field. Validation SHALL bound the
document to 64 KiB, 64 operations, nesting depth 3, 2000-character values and
labels, and SHALL require at least one `step`, at least one `expect*`
postcondition, and every top-level operation to be a `step` or an `optional`.

#### Scenario: A valid data block is accepted
- **WHEN** a document declares `id: "qa-ava.address.searchPostalCode"`, one `step` that types `{{ args.postalCode }}` into `{ testId: "addressPage__search" }`, clicks the suggestion and reads the city into a declared output
- **THEN** validation SHALL accept it and the block SHALL be usable by the plan validator, the runner, the catalog and a flow

#### Scenario: Unknown operation is refused
- **WHEN** a document contains an operation with `op: "evaluate"` or a `script` field
- **THEN** validation SHALL refuse the document with a path-addressed issue and SHALL NOT store or execute it

#### Scenario: Path outside the application is refused
- **WHEN** a `goto` operation uses `https://example.test/x`, `//host/x` or a path containing `..`
- **THEN** validation SHALL refuse the document and no navigation SHALL be attempted

#### Scenario: Undeclared parameter reference is refused
- **WHEN** an operation interpolates `{{ args.postalCode }}` while the parameter schema declares no `postalCode`
- **THEN** validation SHALL refuse the document naming the field

### Requirement: A data block compiles to the existing block contract
A validated document SHALL compile to one frozen `BlockDefinition` whose `run`
interprets the document, so that plan validation, `requires`/`provides`
ordering, effect policy, the catalog, flow generation and the replay fixture
consume it without a second format. The definition SHALL carry the document
itself so a data block is distinguishable from a checked-in block, and the block
digest SHALL hash the document body rather than only the interpreter source. A
data block SHALL NOT declare a contract test, an export name or a barrel entry.

#### Scenario: Digest covers the document body
- **WHEN** two data blocks share the interpreter but have different operations
- **THEN** their digests SHALL differ, and editing one document SHALL change only that block's digest

#### Scenario: Data block is visible as data
- **WHEN** an agent asks `stage_blocks` for a data block's full entry
- **THEN** the entry SHALL carry the kind `data`, its postcondition and its parameter/return schemas, and SHALL omit a contract test and any source code

### Requirement: Approved data blocks and drafts load at use time
The system SHALL store an approved data block as
`<configDir>/stages/blocks/<system>/<id>.json` with the version inside the
document, and SHALL compose the registry per call from the checked-in blocks,
the approved store and the calling workflow's drafts. A block saved or promoted
in one run SHALL therefore be available to `stage_blocks`, `stage_run`, flow
eligibility and the next run's tester without a rebuild or a restart. A
document SHALL be excluded with a value-free diagnostic and SHALL NOT be loaded
when it is invalid, unreadable, larger than the bound, more than 200 documents
exist, its id collides with a checked-in block or another data file, or an
adjustment changes the parameter schema, return schema, application scope, role
list, effect set or state tags without a major version increment. The generated
catalog build artifact SHALL continue to describe only the checked-in blocks.

#### Scenario: A promoted block is usable in the next run
- **WHEN** a run promotes `qa-ava.address.searchPostalCode` at review approval and a new stage test starts
- **THEN** the new run's catalog SHALL list it and `stage_run` SHALL accept a plan that names it without a rebuild or a restart

#### Scenario: Duplicate id is excluded
- **WHEN** an approved data document declares the id of a checked-in block
- **THEN** the composition SHALL report a duplicate-id diagnostic and SHALL keep the checked-in block in the catalog

#### Scenario: Breaking adjustment without a major bump is excluded
- **WHEN** an approved document's new version makes a parameter required that was optional while keeping the major version
- **THEN** the composition SHALL exclude the file with a breaking-contract diagnostic and the previously approved document SHALL remain in effect

#### Scenario: Unreadable file does not stop the catalog
- **WHEN** one store file is not valid JSON
- **THEN** the catalog SHALL still list every other block and the diagnostic SHALL name the file without echoing its content

### Requirement: A draft is scoped to the authoring run
The stage-tester SHALL author a block as a draft stored under the run's own
workflow directory, and a draft SHALL be visible only to the run that created it:
the run's `stage_blocks` and `stage_run` see it, another run's catalog and flow
eligibility do not, and a flow SHALL never pin it. A draft SHALL record the
stage, plan id, revision and the newest five execution proofs (`status`, time,
journal ids, evidence ids, and the version and digest of the document that ran),
all of them derived by the engine from the run's own state rather than supplied
by the tester. Running a plan that uses the draft SHALL append a proof of the
document it ran; editing the document SHALL NOT carry a proof over to the new
body or version. Drafts SHALL be removed when the workflow's workspace is
closed, and a follow-up round SHALL keep them so the tester can continue.

#### Scenario: Draft runs in its own run
- **WHEN** the tester saves a draft and runs it through `stage_run` in the same run
- **THEN** the run SHALL execute the draft and record a proof on it

#### Scenario: Draft is invisible elsewhere
- **WHEN** another stage test lists the catalog or generates a flow in the same server process
- **THEN** the draft SHALL NOT appear and generation SHALL refuse a step that names it with `flow-block-draft`

#### Scenario: Follow-up keeps the draft
- **WHEN** the developer requests a follow-up instead of approving
- **THEN** the workflow SHALL return to `stage.execute` with the draft still available

### Requirement: The stage-tester saves a block through stage_block_save
The system SHALL expose a `stage_block_save` tool to the stage-tester only. It
SHALL refuse a call unless the calling workflow is at `stage.execute`, the session
is bound to the pinned stage, the document's application and roles are declared by
that stage, the document contains no `destructive` effect, a `write` document is on
a writable stage, the document contains no configured secret value, and the
document is valid under the data block schema and the store's collision and
versioning rules. No plan approval SHALL be consulted: the stage's `access` is the
write boundary. It SHALL refuse to edit a checked-in block. It SHALL write or
replace the run's draft atomically with mode `0600` and answer with the draft's
status, id, version, digest, the version it replaced and the recorded proofs, never
the credential values.

#### Scenario: Save outside the execute step is refused
- **WHEN** the reviewer calls `stage_block_save`
- **THEN** the call SHALL be refused because the workflow is not at `stage.execute`

#### Scenario: Save without a stage-bound session is refused
- **WHEN** the tester calls `stage_block_save` with no stage-bound session
- **THEN** the call SHALL be refused and no file SHALL be written

#### Scenario: Checked-in block is read-only
- **WHEN** the tester saves a document whose id is a checked-in block
- **THEN** the call SHALL be refused with a checked-in read-only reason and a new intent id SHALL be required

#### Scenario: Secret value in the document is refused
- **WHEN** a document contains a value equal to a configured stage secret
- **THEN** the call SHALL be refused and the document SHALL NOT be stored

### Requirement: A data block cannot widen stage policy
Interpreting a data block SHALL use only the existing stage context and page
facade, so the stage's origin allow-list, session rules, read-only rule, write
approval, journal redaction and sanitised URLs apply unchanged. A data block
with a `write` effect SHALL execute only on a `writable` stage; the stage's
`access` is the only write boundary and no plan declares data creation. A
`destructive` document SHALL be refused at save time and at composition time; a
data block SHALL NOT reach a credential value except through `ctx.secret`, and a
captured or read value SHALL be journalled only as the existing redactor allows. An
`optional` operation whose operations fail SHALL record the failure in that
sub-step's observed text and SHALL let the block continue.

#### Scenario: Write block on a writable stage runs
- **WHEN** a plan on a writable stage runs a data block with effect `write`
- **THEN** the run SHALL execute that step

#### Scenario: Read-only stage refuses a data block write
- **WHEN** a data block with effect `write` is saved or executed on a read-only stage
- **THEN** the save or the execution SHALL be refused with the stage's existing read-only reason

#### Scenario: Forbidden origin inside a data block
- **WHEN** a `goto` path resolves outside the pinned stage's application origin
- **THEN** the existing origin refusal SHALL fail the block and the plan SHALL stop at it

#### Scenario: Optional operation records its failure
- **WHEN** an `optional` operation's click fails because no cookie banner exists
- **THEN** the sub-step SHALL record the skip reason and the following steps SHALL still run

### Requirement: Review approval promotes drafts into the shared store
Approving the stage review SHALL promote the run's *claimed* drafts into the
approved store atomically: every draft the report claims SHALL be revalidated,
written as an approved file, and removed from the draft directory, and a draft
the report does not claim SHALL never be published — the reviewed set and the
published set SHALL be the same set. A failure SHALL roll back the files it
already wrote and leave every draft in place with a bounded, value-free failure
message. A promotion SHALL never overwrite a checked-in block and SHALL never
downgrade a version. The approval SHALL be enqueued as durable work on the
review approval transition rather than performed inline, and a workflow pinned
to an older definition SHALL complete without promoting anything. Re-running an
approval whose drafts are already published SHALL report the published set
instead of failing or publishing twice.

#### Scenario: Approval promotes
- **WHEN** the developer approves a review whose report claims two created blocks
- **THEN** both documents SHALL appear in the approved store and their drafts SHALL be gone

#### Scenario: An unclaimed draft is not published
- **WHEN** the run saved three drafts and its report claims one
- **THEN** exactly that document SHALL appear in the approved store and none of the drafts SHALL remain

#### Scenario: Promotion failure keeps drafts
- **WHEN** a draft fails revalidation at promotion time
- **THEN** nothing SHALL be promoted, the drafts SHALL remain and the failure SHALL name the block and the reason without a value

#### Scenario: Report without promotion claims is unchanged
- **WHEN** the developer approves a review whose report lists no created or adjusted block
- **THEN** the promotion SHALL do nothing and the workflow SHALL complete as today

