# workflow-blueprints Specification

## Purpose
TBD - created by archiving change add-workflow-blueprint-compiler. Update Purpose after archive.
## Requirements
### Requirement: Blueprints use logical steps only

A workflow blueprint SHALL declare a label, a rationale, repository family
traits, whether the repository checkout is required, logical steps, edges with
optional loop bounds, and a verification round count. It SHALL reference only steps in the blueprint step catalog; routing,
triage-routing and gate steps SHALL be rejected with a diagnostic stating that
the compiler inserts them.

#### Scenario: Internal step in a blueprint

- **WHEN** a blueprint lists `core.route-implementation`
- **THEN** compilation SHALL fail with a diagnostic naming that step

### Requirement: Compilation matches the newest built-in tier

The compiler SHALL insert the triage routing step, the stage gates and the
per-step routing steps exactly as the newest built-in tier does, move the run's
entry onto an inserted step when one stands in front of the graph's entry, wire
every triage-routing outcome, pin exact step references, derive the manifest
policy from the blueprint's traits, and validate the result with the registry's
structural validation, without registering it. A blueprint describing a
repository code-change family's logical graph (`openspec`, `openspec-apply`,
`openspec-propose`, `openspec-fusion`, `openspec-fusion-propose`, `no-openspec`,
`solo`, `rebase`, `verify`) SHALL compile to that family's steps and edges. A
gated stage keeps its newest-tier stage gate even when it is also the graph's
entry (the documentation-only `wiki` shape), because the custom-definition
invariants require a gate in front of every gated stage present. Compilation
SHALL be deterministic.

#### Scenario: Built-in equivalence

- **WHEN** a blueprint with the `no-openspec` family's logical steps and edges is
  compiled
- **THEN** the compiled steps and edges SHALL equal the newest-tier `no-openspec`
  definition's

#### Scenario: Determinism

- **WHEN** the same blueprint is compiled twice
- **THEN** both results SHALL have the same digest

### Requirement: Compiled blueprints keep every human review

Compilation SHALL fail when, in the logical graph: the entry step can reach
delivery, archive or wiki without passing a developer or findings review (the
entry step itself is never a delivery target — a graph whose entry is the
guarded `core.wiki` is handled by the wiki-approval clause and keeps its
newest-tier gate); a workflow that pushes code (it contains delivery or archive,
or its delivery trait is `pull-request` and its `core.completed` can create a
pull request) can reach completion without passing a developer or findings
review; planning can reach implementation, delivery, archive or completion
without passing plan approval; or wiki work can reach archive, delivery or
completion without passing wiki approval. A workflow that pushes nothing — the
solo shape, whose completion offers no pull request and whose only exit is
completion — is exempt from the completion part of the implementation rule. Each
failure SHALL name the rule and an offending path.

#### Scenario: Review skipped

- **WHEN** a blueprint connects `core.verification` `pass` directly to
  `core.delivery`
- **THEN** compilation SHALL fail naming the developer review rule

#### Scenario: Review loop is valid

- **WHEN** developer review comments return to implementation and implementation
  reaches delivery only through developer review
- **THEN** compilation SHALL succeed

### Requirement: Blueprint bounds

Compilation SHALL reject a blueprint whose logical step count, loop attempts or
verification round count exceeds the ranges used by the built-in catalog, whose
derived entry step is not a step a run may begin with, or whose verification
round count is not carried by a `core.verification` `fix` loop bound of exactly
that count (a verifying graph that declares no such edge is rejected).

#### Scenario: Unbounded retry

- **WHEN** a blueprint declares a loop with more attempts than the built-in maximum
- **THEN** compilation SHALL fail naming the edge

### Requirement: Server validates and starts blueprints

The unified server SHALL serve the blueprint step catalog and a validation route
that compiles a blueprint without any side effect and returns its compiled
summary, digest and diagnostics. The start route SHALL accept exactly one of a
built-in workflow type or a blueprint. For a blueprint it SHALL compile it, store
the resulting definition in the target store with its origin, pin the
blueprint's label, rationale and digest on the workflow, and start it; a
blueprint that fails compilation SHALL be refused before anything is written.

#### Scenario: Validate has no side effects

- **WHEN** a blueprint is validated
- **THEN** the response SHALL contain its digest or diagnostics
- **AND** no definition or workflow SHALL be stored

#### Scenario: Start with a blueprint

- **WHEN** a valid blueprint start is accepted
- **THEN** the workflow SHALL pin a `custom.` definition whose digest equals the
  validated digest
- **AND** its metadata SHALL carry the blueprint label and rationale

#### Scenario: Both type and blueprint

- **WHEN** a start request names both a workflow type and a blueprint
- **THEN** the server SHALL reject it as malformed

