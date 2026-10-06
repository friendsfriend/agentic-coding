# Spec Delta

## ADDED Requirements

### Requirement: Declared repository family traits

A repository-target code-change workflow definition SHALL be able to declare
family traits in its manifest policy: whether it produces OpenSpec change
artifacts, its planning mode, how its change identity is chosen, whether it
delivers a pull request, its start requirements, and whether the OpenSpec
verifier is eligible. Registration SHALL reject traits on a non-repository
target, unknown values, and traits inconsistent with the graph's steps, naming
the manifest. The engine SHALL expose the effective traits of any registered
repository code-change definition, using a declared fallback for definition
versions registered before traits existed.

#### Scenario: Inconsistent traits are rejected

- **WHEN** a manifest declares `planning: fusion` without a fusion planning step
- **THEN** registration SHALL fail naming the manifest

#### Scenario: Older tier has effective traits

- **WHEN** the effective traits of a workflow pinned to a pre-traits tier are read
- **THEN** they SHALL equal the traits its family declares at the traits tier

### Requirement: Family traits tier

The family traits SHALL be introduced as a new definition version tier in which
every built-in family is registered and the repository code-change families
carry their traits; new starts SHALL resolve this tier, and every earlier tier
SHALL keep its graph, its policy, and its digest. Declaring traits SHALL NOT
change any engine behavior.

The tier SHALL also register `research` with the full-tool policy
(`requiresReadOnlyResearcher: false`), the policy
`definitionVersionForResearchTools` documents, because the step-routing tier's
second catalog-policy pass had reverted it and left every research start
refused by a guard that looks for a route named by `definition.initial` — which
per-step routing rewrites to the `core.route-research` system step. Apart from
that one policy, the tier's graphs SHALL be identical to the step-routing
tier's.

#### Scenario: Pinned workflow is unaffected

- **WHEN** a workflow pinned to an earlier tier continues after this tier is
  registered
- **THEN** it SHALL keep its definition digest and dispatch without repair

#### Scenario: Traits match current behavior

- **WHEN** the built-in catalog is registered
- **THEN** every repository code-change family's declared traits SHALL equal the
  per-family fallback table

#### Scenario: A new research start is accepted

- **WHEN** a `research` workflow starts on the family-traits tier
- **THEN** the start SHALL be accepted, and the tiers below SHALL keep their
  original `research` policy and digest
