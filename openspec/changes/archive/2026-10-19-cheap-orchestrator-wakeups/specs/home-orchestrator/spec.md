## ADDED Requirements

### Requirement: Orchestrator starts a workflow from a task reference

`start_workflow` SHALL accept a task reference as an alternative to inline `task`
text, and SHALL refuse a call that carries both or neither, naming both
parameters. A reference SHALL be either an OpenSpec change of the target
repository (a change id, or a path inside that repository's
`openspec/changes`) or the session's previous developer message. The server SHALL
resolve a change reference to that change's `proposal.md` and `tasks.md` content
as the task, and SHALL echo the resolved change id and the resolved task length
in the start answer. The host SHALL resolve the previous-message reference to the
developer's own last message of the session — never a monitor note or an abort
marker — and SHALL name that source and its length in the answer. A reference
SHALL be refused, in one bounded message that names the candidates, when it does
not resolve, when it matches more than one change, or when it names an archived
change. Inline `task` SHALL keep working unchanged, and a reference SHALL pass
the same start guard, the same preset and branch rules and the same human reviews
as inline text.

#### Scenario: A change reference starts the workflow and echoes its resolution

- **WHEN** the orchestrator calls `start_workflow` with `taskRef: { change:
  "add-stage-oauth2-auth" }` for a repository whose active changes include that
  id
- **THEN** the started workflow's task SHALL be the text assembled from that
  change's `proposal.md` and `tasks.md`
- **AND** the answer SHALL name the resolved change id and the resolved task
  length

#### Scenario: An unresolved reference names the candidates

- **WHEN** the reference matches no active change of the repository
- **THEN** the call SHALL be refused without a workflow being started
- **AND** the refusal SHALL name the closest existing change ids, bounded, and
  say how many more exist

#### Scenario: An ambiguous reference is refused rather than guessed

- **WHEN** the reference is a prefix of two or more active changes
- **THEN** the call SHALL be refused without a workflow being started
- **AND** the refusal SHALL name the matches

#### Scenario: The previous message is used as the task

- **WHEN** the orchestrator calls `start_workflow` with `taskRef: {
  previousMessage: true }` after the developer sent a message in the session
- **THEN** the workflow's task SHALL be that developer message verbatim
- **AND** the answer SHALL name the previous message as the task source and its
  length

#### Scenario: No previous developer message is available

- **WHEN** the session carries no developer message yet
- **THEN** the call SHALL be refused without a workflow being started
- **AND** the refusal SHALL name `task` and `taskRef.change` as the alternatives

#### Scenario: Inline task text is unchanged

- **WHEN** the orchestrator calls `start_workflow` with `task` text and no
  `taskRef`
- **THEN** the start SHALL behave exactly as before this change, including its
  answer

### Requirement: Orchestrator lists a repository's OpenSpec changes

The orchestrator tool surface SHALL include one listing tool for a repository's
OpenSpec changes that answers compact rows — change id, title, task progress and
the change's repository-relative path — and SHALL mark a change that a
non-closed workflow of that repository is already implementing. The listing SHALL
read only the repository's `openspec/changes` directory, SHALL exclude archived
changes, SHALL be bounded in the number of rows and in the length of each title,
and SHALL answer an empty list for a repository without that directory. The
existing change-id observation the dashboard reads SHALL keep its shape.

#### Scenario: Changes are listed as compact rows

- **WHEN** the orchestrator lists the changes of a repository holding active
  changes
- **THEN** each row SHALL carry the change id, its title, its checked/total task
  count and its `openspec/changes/<id>` path
- **AND** no row SHALL carry file contents

#### Scenario: A change already being implemented is marked

- **WHEN** a non-closed workflow of that repository implements one of the listed
  changes
- **THEN** that row SHALL name the workflow id and its status

#### Scenario: A repository without OpenSpec changes

- **WHEN** the repository has no `openspec/changes` directory
- **THEN** the listing SHALL answer an empty list rather than fail

### Requirement: One workflow identifier across the list and the status poll

`workflow_status` SHALL accept the `workflowId` that `list_workflows` returns
without also being given the repository: when `repo` is omitted the tool SHALL
resolve the repository from the same workflow board `list_workflows` reads, and
SHALL answer one row per repository when that id exists in more than one. An
unknown id SHALL be answered, not failed, with the closest existing ids bounded
and a note when more exist. `workflow_status` SHALL accept several ids in one
call, each with its own `sinceRevision`, and SHALL answer one compact entry per
id in the requested order. A call that names a single id SHALL answer exactly the
shape it answers today, and no row SHALL gain a field.

#### Scenario: A poll without a repository resolves it from the board

- **WHEN** the orchestrator polls the `workflowId` it read from `list_workflows`
  and omits `repo`
- **THEN** the poll SHALL answer that workflow's compact row, including its
  `target`

#### Scenario: An unknown id answers with the closest ids

- **WHEN** the orchestrator polls an id that no workflow on the board has
- **THEN** the answer SHALL name the closest existing ids, bounded
- **AND** the call SHALL NOT fail

#### Scenario: Several ids are polled in one call

- **WHEN** the orchestrator polls three ids, one of them with the revision of its
  own last answer
- **THEN** the answer SHALL carry three compact entries in the requested order
- **AND** the unchanged one SHALL answer in a few bytes, naming its
  `workflowId`, revision, status and step

#### Scenario: A single-id answer is unchanged

- **WHEN** the orchestrator polls one id with `sinceRevision` equal to its
  current revision
- **THEN** the answer SHALL be the few-byte `unchanged` answer it answers today

### Requirement: A refused start names what stopped it

`start_workflow` SHALL name what stopped a refused start: a refusal because the
target repository's working tree is not clean SHALL carry the number of dirty
paths and a bounded list of them, without file contents, and `start_workflow`
SHALL return that refusal verbatim. The
clean-tree requirement itself SHALL be unchanged: a reference start is refused
exactly like an inline-text start.

#### Scenario: A dirty tree refusal lists the paths

- **WHEN** `start_workflow` is called for a repository with dirty paths
- **THEN** the call SHALL be refused with the dirty-path count and a bounded list
  of the paths
- **AND** no file content SHALL appear in the refusal
