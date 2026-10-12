## MODIFIED Requirements

### Requirement: Blueprints use logical steps only

A workflow blueprint SHALL declare a label, a rationale, repository family
traits, whether the repository checkout is required, logical steps, edges with
optional loop bounds, and a verification round count. It SHALL reference only steps in the blueprint step catalog; the
triage-routing step and gate steps SHALL be rejected with a diagnostic stating
that the compiler inserts them, and a retired step identifier such as a
`core.route-*` step SHALL be rejected as an unknown step.

#### Scenario: Internal step in a blueprint

- **WHEN** a blueprint lists `core.triage-route`
- **THEN** compilation SHALL fail with a diagnostic naming that step

#### Scenario: Retired routing step in a blueprint

- **WHEN** a blueprint lists `core.route-implementation`
- **THEN** compilation SHALL fail with a diagnostic naming that step as unknown

### Requirement: Compilation matches the newest built-in tier

The compiler SHALL insert the triage routing step and the stage gates exactly as
the newest built-in tier does, move the run's entry onto an inserted step when
one stands in front of the graph's entry, wire every triage-routing outcome, pin
exact step references, derive the manifest policy from the blueprint's traits,
and validate the result with the registry's structural validation, without
registering it. A blueprint describing a repository code-change family's logical
graph (`openspec`, `openspec-apply`, `openspec-propose`, `openspec-fusion`,
`openspec-fusion-propose`, `no-openspec`, `solo`, `rebase`, `verify`) SHALL
compile to that family's steps and edges. A gated stage keeps its newest-tier
stage gate even when it is also the graph's entry (the documentation-only `wiki`
shape), because the custom-definition invariants require a gate in front of every
gated stage present. Compilation SHALL be deterministic.

#### Scenario: Built-in equivalence

- **WHEN** a blueprint with the `no-openspec` family's logical steps and edges is
  compiled
- **THEN** the compiled steps and edges SHALL equal the newest-tier `no-openspec`
  definition's
- **AND** neither SHALL contain a `core.route-*` step

#### Scenario: Determinism

- **WHEN** the same blueprint is compiled twice
- **THEN** both results SHALL have the same digest
