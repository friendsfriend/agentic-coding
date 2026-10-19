## ADDED Requirements

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
