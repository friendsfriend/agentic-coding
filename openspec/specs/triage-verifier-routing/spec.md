# triage-verifier-routing Specification

## Purpose
Define how the JEV classifier decides which verifier roles run in each
verification round from a bounded view of the change, how the triage agent is
narrowed to scoping those roles to changed files, and what happens when the
classifier selects nothing or cannot answer at all.
## Requirements
### Requirement: Per-round classifier-driven verifier role selection

Every verification round SHALL pass through a `core.triage-route` system step
before `core.triage` in the shared implementation loop. The step SHALL enqueue
exactly one classifier request carrying one independent question per eligible
verifier role and SHALL resolve the roles whose answers reach the 0.5
inclusion threshold for every round whose role set the engine does not scope
itself; a round the engine scopes SHALL take its role set from the scope and the
classifier's role answers SHALL be recorded without deciding that round. Eligible
roles SHALL be the registered verifier role catalog minus the engine-owned
full-suite role, with the OpenSpec verifier role additionally excluded for
definitions that declare no OpenSpec surface. No role SHALL be selected by a
forced baseline: the correctness and OpenSpec verifier roles SHALL be
classifier-decided like every other role, and selecting zero roles SHALL be a
valid outcome. The same request SHALL additionally carry the verification gate's
single question of whether the change needs independent verification before it is
archived, and the step SHALL have a third outcome, distinct from an empty role
selection, that bypasses both `core.triage` and `core.verification` for the
round. The gate question SHALL be asked only when the verification gate's
resolved policy permits the classifier to decide it; a resolved policy of
`always` SHALL take the round's continuing outcome without asking. Stage gate
semantics are specified by the `stage-gates` capability.

#### Scenario: Implementation enters the routing step

- **WHEN** `core.implementation` completes
- **THEN** the definition SHALL enter `core.triage-route` before `core.triage`
- **AND** entering the step SHALL enqueue one classification effect that is the
  step's only allowed external effect

#### Scenario: Confident answers select roles

- **WHEN** the classifier answers with a value of at least 0.5 for two of the
  eligible role questions and below 0.5 for the rest, and the engine does not
  scope the round
- **THEN** exactly those two roles SHALL be selected for the round
- **AND** the step SHALL continue to `core.triage`

#### Scenario: Zero roles selected

- **WHEN** every eligible role question is answered below 0.5 on a round the
  engine does not scope
- **THEN** the routing step SHALL report an empty selection
- **AND** the definition SHALL skip `core.triage` and enter `core.verification`
  with no domain verifier selected

#### Scenario: The full-suite role is never a question

- **WHEN** the routing step builds its classifier questions
- **THEN** it SHALL NOT ask about the engine-owned full-suite verifier role
- **AND** that role SHALL remain the engine's automatic launch after the
  selected verifiers report

#### Scenario: OpenSpec verifier is not asked without an OpenSpec surface

- **WHEN** the resolved definition declares no OpenSpec surface
- **THEN** no question SHALL be asked for the OpenSpec verifier role
- **AND** the remaining eligible roles SHALL still be asked

#### Scenario: Routing repeats for every verification round

- **WHEN** a verification round ends in a fix outcome and implementation runs
  again
- **THEN** the definition SHALL enter the routing step again before the next
  `core.triage`

#### Scenario: The gate question travels with the role questions

- **WHEN** the verification gate's policy permits the classifier to decide it
- **THEN** the routing step's single request SHALL carry the role questions and
  the verification gate question together
- **AND** it SHALL NOT issue a second request for the gate question

#### Scenario: The gate question is not asked under a mandatory policy

- **WHEN** the verification gate's resolved policy is `always`
- **THEN** no gate question SHALL be asked
- **AND** the round SHALL continue into triage or verification without a skip
  outcome being possible

#### Scenario: Verification is reported as unnecessary

- **WHEN** the gate question is answered below 0.5
- **THEN** the routing step SHALL take its skip outcome
- **AND** the definition SHALL bypass both `core.triage` and `core.verification`
  and continue with the developer review gate

#### Scenario: A scoped round still asks the classifier

- **WHEN** the round follows a fix and the engine scopes its role set
- **THEN** exactly one classification effect SHALL still be enqueued, with one
  question per eligible role and the gate question
- **AND** the round's role set SHALL be the scope's, with the classifier's role
  answers recorded and not used to select roles

#### Scenario: The gate verdict still resolves first on a scoped round

- **WHEN** the gate answers skip on a round the engine scoped
- **THEN** the routing step SHALL take its skip outcome and SHALL NOT enter triage
  or verification

### Requirement: Independent per-role classifier questions

A routing request SHALL carry every eligible role's question in parallel as a
single boolean-necessity question, and each question SHALL be mapped to exactly
one role. A role SHALL be selected when its answer value is at least 0.5 and
SHALL NOT be selected otherwise; the answer SHALL NOT be filtered by any other
field. The classifier SHALL reuse the same endpoint and profile used for model
pool routing, and a routing request SHALL resolve no model, profile, or pool.

#### Scenario: One request asks every eligible role

- **WHEN** the routing step invokes the classifier
- **THEN** exactly one request SHALL carry one question per eligible role
- **AND** it SHALL NOT issue one request per role

#### Scenario: Answer at the threshold is included

- **WHEN** a role question is answered with exactly 0.5
- **THEN** that role SHALL be selected

#### Scenario: Answer below the threshold is excluded

- **WHEN** a role question is answered with a value below 0.5
- **THEN** that role SHALL NOT be selected

#### Scenario: Answer without a usable value

- **WHEN** a role question is missing, malformed, or carries no numeric value
- **THEN** the classification SHALL be treated as incomplete rather than as a
  verdict, and the round SHALL fail open: `core.triage` SHALL run against the full
  eligible catalog and an `attention` entry SHALL name how many questions were answered
- **AND** narrowing a round SHALL require a complete, positive answer set, so a
  truncated response can never be trusted more than an absent one

#### Scenario: Routing resolves no model

- **WHEN** a routing request completes
- **THEN** the workflow's pinned model routing SHALL be unchanged
- **AND** no agent preset pool SHALL be read to answer the questions

### Requirement: Bounded changed-file classification state

The classification state SHALL consist of the task, a bounded plan summary, the
engine's changed-file manifest, and per-file diff text. The manifest SHALL be
produced by the same observation the engine uses to validate triage scoping, so
the classifier sees exactly the files the engine will accept. Total diff bytes
and per-file diff bytes SHALL each be capped, and overflow SHALL truncate
deterministically. Every changed-file path SHALL appear in the state in full
even when its diff text is truncated or omitted.

#### Scenario: Changed manifest matches validated scope

- **WHEN** the routing state is assembled for a round
- **THEN** its changed-file list SHALL be the engine's validated changed-file
  manifest for that round
- **AND** no separate scope derivation SHALL be used

#### Scenario: Diffs exceed the per-file cap

- **WHEN** a single changed file's diff exceeds the per-file byte cap
- **THEN** that file's diff text SHALL be truncated to the cap
- **AND** its path SHALL still be listed in full

#### Scenario: Diffs exceed the total cap

- **WHEN** the collected diff text exceeds the total byte cap
- **THEN** files SHALL be included in a stable order until the cap is reached
- **AND** every remaining changed-file path SHALL still be listed in full with
  no diff text

### Requirement: Triage scopes the classifier-selected roles

The triage agent SHALL receive the round's locked role selection and SHALL
emit a plan whose roles are a subset of that selection; it MAY drop a selected
role whose files are not relevant and SHALL NOT introduce a role outside the
selection. A plan that adds a role, names a role the plan does not scope,
duplicates a role, or scopes a file outside the changed-file manifest SHALL be
rejected. Only the roles the triage plan keeps SHALL reach the verification
step, and each SHALL be scoped to the changed files that role must see. The
selection is the classifier's for a round the engine did not scope and the
engine's re-verification scope for a round it did; the plan's obligations are the
same either way.

#### Scenario: Subset is accepted

- **WHEN** the classifier selects three roles and the triage plan scopes two of
  them to changed files
- **THEN** the plan SHALL be accepted
- **AND** exactly those two roles SHALL run for the round

#### Scenario: Adding an unselected role is rejected

- **WHEN** the classifier selected two roles and the triage plan also names a
  third role that was not selected
- **THEN** the plan SHALL be rejected as an invalid verifier role selection
- **AND** no verifier run SHALL launch from that plan

#### Scenario: File outside the changed scope is still rejected

- **WHEN** a triage plan scopes a selected role to a file that is not in the
  changed-file manifest
- **THEN** the plan SHALL be rejected
- **AND** the same rejection SHALL apply regardless of how the role was chosen

#### Scenario: Triage is instructed to scope, not to select

- **WHEN** the triage instruction asset is rendered for a round
- **THEN** it SHALL present the round's role set as already decided
- **AND** it SHALL NOT present a role-selection table or invite a role the
  classifier did not select

#### Scenario: Unconstrained triage after a classifier failure

- **WHEN** triage runs for a round in which the classifier did not produce a
  selection and the engine did not scope the round
- **THEN** the plan SHALL be validated against the full eligible role catalog
  rather than an empty set
- **AND** the plan SHALL be accepted or rejected exactly as it was before this
  change

#### Scenario: An engine-scoped selection is scoped like any other

- **WHEN** the round's selection came from the engine's re-verification scope and
  the triage plan scopes a subset of it
- **THEN** the plan SHALL be accepted under the same rules as a classifier
  selection
- **AND** a plan naming a role outside the scope SHALL be rejected

### Requirement: Empty domain selection resolves to the full suite only

A verification step entered with an empty role selection SHALL fan out the
engine-owned full-suite verifier role only. The round SHALL still pass once that
run reports without critical findings, and the engine's automatic launch of the
full suite after the selected verifiers report SHALL remain unchanged for every
round with a non-empty selection.

#### Scenario: Zero-role round runs the suite and passes

- **WHEN** a round reaches verification with no domain verifier selected
- **THEN** the only verifier run SHALL be the engine-owned full-suite role
- **AND** the round SHALL transition to the passing outcome once that run
  reports no critical findings

#### Scenario: Non-empty rounds keep the automatic launch

- **WHEN** a round has at least one selected domain verifier
- **THEN** the engine SHALL still launch the full-suite role exactly once after
  the selected verifiers report and the suite has not already run

### Requirement: Classifier failure never blocks verification

A classification failure SHALL NOT stop the workflow — a missing credential, a
provider error, an invalid response body, answers with no usable value, **or a
partially answered classification**. For a round the engine does not scope, the
routing step SHALL let `core.triage` run unconstrained, exactly as it did before
this change, and the workflow SHALL record an `attention` entry naming the
failure. For a round the engine scopes, the failure SHALL leave the scope in
place, because the scope is computed from the previous round's plan and the
fix's own delta, neither of which came from the classifier. The full-suite verifier role SHALL remain reachable in that round. A
selection that is not complete SHALL NOT be used to narrow the round, and a
zero-role selection SHALL still be recorded in `attention` so a skipped gate is
never silent. A failure of the verification gate question SHALL never skip the
round: the routing step SHALL take its continuing outcome so triage and
verification still run, and the failure SHALL be recorded as a forced run with an
`attention` entry.

#### Scenario: Missing credential fails open

- **WHEN** the classifier request cannot be sent because its credential is
  absent
- **THEN** `core.triage` SHALL run with the full eligible role catalog available
- **AND** the workflow SHALL record an `attention` entry

#### Scenario: Provider failure fails open

- **WHEN** the classifier provider returns an error or an unparsable body
- **THEN** the routing step SHALL still complete
- **AND** the workflow SHALL continue to an unconstrained `core.triage` with an
  `attention` entry rather than entering attention-required

#### Scenario: Gate failure still runs the round

- **WHEN** the verification gate question cannot be obtained or carries no usable
  value
- **THEN** the routing step SHALL NOT take its skip outcome
- **AND** the round SHALL proceed to triage or verification with an `attention`
  entry naming the gate failure

#### Scenario: An outage does not widen a scoped round

- **WHEN** the classification fails on a round the engine scoped
- **THEN** the round's role set SHALL be the scope's, not the full eligible
  catalog
- **AND** the workflow SHALL still record the `attention` entry for the failure

### Requirement: Re-verification is scoped to the fix's owners

For a round that follows a fix in the shared implementation loop, the routing step SHALL select the round's verifier roles itself whenever the previous
round's plan attributes every file the fix changed in content to exactly one
role: the roles that own those files, and no other role. A file the fix did not
change in content — including a file it changed only in whitespace — SHALL NOT
select an owner. The engine-owned full-suite verifier role SHALL remain the
engine's automatic launch, SHALL NOT be part of the scope, and SHALL run in every
round. The round's plan ownership SHALL be persisted by the engine when triage
produces it, because the step context that carries it is reset by the round's
transition.

#### Scenario: A fix that touched one role's file re-runs that role only

- **WHEN** the previous round planned `quality-verifier` on `src/a.ts` and
  `security-verifier` on `src/b.ts`, and the fix changed `src/a.ts`
- **THEN** the next round's arriving selection SHALL be `quality-verifier`
- **AND** `security-verifier` SHALL NOT run in that round
- **AND** the engine-owned full-suite role SHALL still run

#### Scenario: Every role whose file the fix touched runs

- **WHEN** the fix changed files that the previous plan assigned to two different
  roles
- **THEN** both roles SHALL be in the next round's selection

#### Scenario: A role whose files were not touched does not run

- **WHEN** the fix changed no file the previous plan assigned to a role
- **THEN** that role SHALL NOT be selected for the next round
- **AND** its participation SHALL be recorded with the reason it did not run

#### Scenario: A first round stays classifier-decided

- **WHEN** no previous verification round has completed, or the previous round's
  record is not the last completed round
- **THEN** the round's roles SHALL be resolved exactly as they were before this
  change

#### Scenario: The full-suite role is never scoped away

- **WHEN** any scoped round reaches `core.verification`
- **THEN** the engine SHALL still launch the full-suite verifier role exactly
  once, as it does for every round with a non-empty selection

### Requirement: A bounded minimum fix diff decides whether a domain round opens

A round that follows a fix SHALL measure that fix as the set of files whose
content changed since the tree the previous round verified, excluding changes
that differ only in whitespace and counting an added or removed file as a content
change. The round SHALL open with the owners selected only when that count
reaches `workflow.min_reverification_changed_files`, an integer from 0 to 20
whose default is 1 and whose value 0 disables the rule. Below the threshold the
round SHALL open no domain verifier **other than the roles that reported the
findings the fix resolved**, which run whatever the count is and however their
files were touched. When no reported role is left, the round below the threshold
SHALL take the routing step's existing zero-role outcome, bypass triage, and run
the engine-owned full-suite role only, and the workflow SHALL record an
`attention` entry naming the below-minimum fix so the round is never silent. A
change to one file, however small that change is, SHALL reach the default
threshold. The threshold SHALL NOT change whether a round happens, how many
rounds the round budget permits, or when the workflow parks or blocks.

#### Scenario: A whitespace-only fix opens no domain round

- **WHEN** the fix changed one file only by indentation or line wrapping, no
  eligible role reported the previous round's findings, and the threshold is the
  default
- **THEN** the next round SHALL select no domain verifier
- **AND** it SHALL run the engine-owned full-suite role only

#### Scenario: A one-line fix still re-runs its owner

- **WHEN** the fix changed one line of one file and the threshold is the default
- **THEN** that file's role SHALL be in the next round's selection

#### Scenario: The round still happens and still counts

- **WHEN** the fix is below the threshold
- **THEN** the round's only verifier run SHALL be the engine-owned full-suite role
- **AND** the round SHALL count against the round budget exactly as any other
  round does

#### Scenario: A below-minimum fix is recorded rather than silent

- **WHEN** the round opens no domain verifier because the fix was below the
  threshold
- **THEN** the workflow SHALL record an `attention` entry naming the below-minimum
  fix
- **AND** the round's decision record SHALL name the threshold and the reason

#### Scenario: A below-minimum fix that resolved a finding still re-runs its role

- **WHEN** the fix changed one file only in whitespace and one eligible role
  reported a critical finding in the round the fix follows
- **THEN** that role SHALL be in the next round's selection with the reason that
  it reported the finding
- **AND** no other domain verifier SHALL be selected

### Requirement: The roles that reported a round's findings always re-run

The round that follows a fix SHALL re-run every eligible role that reported a
critical finding in the round the fix follows, whatever file the fix touched and
whatever the fix's measured diff is: the fix was made to resolve those findings,
so the roles that reported them SHALL verify the resolution. The roles SHALL be
recorded with the round they reported in, because a record from another round
names a finding this fix does not address. A reported role that the definition
can no longer launch — a trait that dropped the role, a plan recorded under a
differently pinned definition — SHALL widen the round rather than be dropped: the
round SHALL be classifier-decided instead of silently running one role fewer. The
engine-owned full-suite role SHALL NOT be part of the reported set, because it is
not part of the catalog a scope may name and it runs in every round regardless.

#### Scenario: A reported role runs although its file was untouched

- **WHEN** `security-verifier` reported the previous round's finding and the fix
  changed only a file `quality-verifier` owns
- **THEN** both roles SHALL be in the next round's selection
- **AND** `security-verifier`'s participation SHALL be recorded as the role that
  reported the finding, and `quality-verifier`'s as the owner of the touched file

#### Scenario: A reported role that cannot be launched widens the round

- **WHEN** the reported role is not part of the definition's eligible verifier
  roles
- **THEN** the round SHALL be classifier-decided rather than scoped
- **AND** the widening reason SHALL name the reported role outside the catalog

#### Scenario: The full-suite role is never a reported role

- **WHEN** the engine-owned full-suite role is the only verifier that reported a
  critical finding in the previous round
- **THEN** the round's reported set SHALL be empty
- **AND** the round SHALL be decided by the fix's measured diff alone

### Requirement: Unattributable fixes widen to the full round

The routing step SHALL leave the round exactly as it is without this change —
classifier-decided, and unconstrained on a classifier outage — whenever it cannot
attribute the fix with confidence: no previous-round record, a record from a
round other than the last completed round, no measured fix delta, a delta that
could not be measured, a previous plan that assigns no file, a substantively
changed file that the previous plan assigned to no role, a substantively
changed file that the previous plan assigned to more than one role, or a reported
role the definition can no longer launch. The delta measurement SHALL be bounded
by a file count, a per-file byte cap, and a total byte cap, and any overflow
SHALL count as unmeasurable rather than as a small fix. The reason for widening
SHALL be recorded.

#### Scenario: No previous record keeps the classifier selection

- **WHEN** a round follows a fix but no usable previous-round record exists
- **THEN** the classifier's role answers SHALL decide the round as they do today

#### Scenario: A file outside the previous plan widens

- **WHEN** the fix changed a file the previous round's plan assigned to no role,
  including a file the fix added
- **THEN** the round SHALL be classifier-decided rather than scoped

#### Scenario: A shared file widens

- **WHEN** the fix changed a file the previous round's plan assigned to two or
  more roles
- **THEN** the round SHALL be classifier-decided rather than scoped
- **AND** no role SHALL be selected on the strength of an ambiguous attribution

#### Scenario: An unmeasurable delta widens

- **WHEN** the fix's delta cannot be measured because the file reads or the
  repository observation failed
- **THEN** the round SHALL be classifier-decided rather than scoped
- **AND** the round SHALL still run

#### Scenario: A truncated plan widens rather than narrowing

- **WHEN** the previous round's plan or the delta exceeded the record's caps
- **THEN** the round SHALL be classifier-decided
- **AND** no role SHALL be skipped on the strength of a truncated record

#### Scenario: A plan the record cannot hold clears the previous ownership

- **WHEN** a round's plan exceeds the record's caps and the round is persisted
- **THEN** the record SHALL carry an empty plan for that round
- **AND** the next round SHALL widen instead of scoping from the previous round's
  ownership

### Requirement: Fix measurement reads only bounded, contained regular files

The measurement SHALL resolve each manifest path inside the worktree before
reading it, SHALL refuse a path that resolves outside the worktree, SHALL refuse
a path that is not a regular file, and SHALL apply its per-file byte cap before
reading a byte. Every refusal SHALL make the observation unmeasurable, which
widens the round rather than failing the handoff that would record it. A path the
tree no longer holds SHALL be measured as the file's absence — a change in its
own right — rather than as a missing measurement, and the record SHALL express
that absence so a deletion-only fix is substantive and an already-absent path is
not. A manifest or plan path longer than the record can carry SHALL be
unmeasurable rather than written into a record the reader would refuse.

#### Scenario: A path that resolves outside the worktree is refused

- **WHEN** a changed-file manifest path is a symlink to a file outside the
  worktree
- **THEN** the observation SHALL be unmeasurable
- **AND** the round SHALL widen without reading the outside file

#### Scenario: A path that is not a regular file is refused

- **WHEN** a changed-file manifest path resolves to a directory, a FIFO, or a
  character device
- **THEN** the observation SHALL be unmeasurable rather than unbounded
- **AND** the round SHALL widen

#### Scenario: An oversized changed file is not read

- **WHEN** a changed file is larger than the per-file cap
- **THEN** the observation SHALL be unmeasurable
- **AND** the file SHALL NOT be read into memory

#### Scenario: A deletion is a substantive change

- **WHEN** a file the previous round's baseline held is gone from the tree
- **THEN** the fix's delta SHALL record that path as a substantive change
- **AND** a path neither tree holds SHALL NOT be recorded as a change

#### Scenario: A path longer than the record can carry widens

- **WHEN** a changed-file manifest path is longer than the record's path bound
- **THEN** the observation SHALL be unmeasurable
- **AND** the round SHALL widen instead of refusing the handoff that records it

### Requirement: The change is accepted only on its measured KPI

The change SHALL be accepted only when its own verification demonstrates both
halves of the efficiency backlog item's target: the share of verifier runs that
re-verify a fix SHALL not rise above the 15% baseline it was measured against,
and the number of accepted findings per verification round SHALL NOT fall. The
figures SHALL be stated against the repaired denominator the backlog item was
re-measured with — 441.9321 units and 34,711 turns — and the backlog item's
original "< 25%" wording SHALL be recorded as stale: the intended target is that
the share does not rise above 15%, not that it falls below 25%.

#### Scenario: The two halves are reported together

- **WHEN** the change's verification records its outcome
- **THEN** it SHALL report the re-verification share against the 15% baseline
- **AND** it SHALL report accepted findings per round alongside it, so neither
  half can be claimed alone

#### Scenario: The stale target wording is not inherited

- **WHEN** the change's record states its target
- **THEN** it SHALL state the 15% baseline and the 441.9321-unit / 34,711-turn
  denominator
- **AND** it SHALL record the "< 25%" wording as a typo in the backlog item

### Requirement: Scoping changes no round, budget, or blocking behaviour

The scope SHALL only choose which verifier roles take part in a round. It SHALL
NOT remove a round, skip the engine-owned full-suite role, change the `fix` edge
or its attempt bound (`max_verification_rounds`), add a workflow outcome or a
graph edge, change when a workflow parks in `attention-required` or blocks, or
change what a round's `pass`, `fix`, `limit`, `blocked`, and `failed` verdicts
mean. A definition that does not include `core.triage-route` SHALL keep its
behaviour unchanged.

#### Scenario: The round budget is unchanged

- **WHEN** every round of a workflow ends in a fix outcome
- **THEN** the number of rounds SHALL be bounded exactly as it was before this
  change

#### Scenario: A critical finding still ends the round in a fix

- **WHEN** a verifier of a scoped round hands over a critical finding
- **THEN** the round SHALL take the fix outcome and implementation SHALL run again

#### Scenario: A definition without the routing step is unchanged

- **WHEN** a definition that predates `core.triage-route` reaches its triage step
  after a fix
- **THEN** no scope SHALL be applied and the triage agent SHALL choose the role
  set as it does today

