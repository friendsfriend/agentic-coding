# Spec Delta

## Purpose

Define how each verifier's file scope is derived from classifier-provided
per-file role tags in the same request that selects the roles, replacing the
triage agent's scoping plan.

## ADDED Requirements

### Requirement: Classifier-provided per-file verifier scope

The per-round classifier request SHALL return, for each changed file, the
verifier roles that need to see it, and each verifier's scope SHALL be the set
of changed files tagged with that role. A tag SHALL be honoured only when it
names a role selected for the same round and a file present in the changed-file
manifest; every other tag SHALL be discarded and recorded. No role SHALL ever
receive an empty scope for a round in which it was selected.

#### Scenario: Tags become verifier scope

- **WHEN** the classifier tags two changed files for the selected role
- **THEN** that role SHALL be assigned exactly those two files
- **AND** no agent plan SHALL be required to derive the scope

#### Scenario: Tag for an unselected role is discarded

- **WHEN** the classifier tags a file with a role it did not select for the
  round
- **THEN** the tag SHALL be discarded
- **AND** the workflow SHALL record that the tag was ignored

#### Scenario: Tag for a file outside the manifest is discarded

- **WHEN** the classifier tags a path that is not in the changed-file manifest
- **THEN** the tag SHALL be discarded
- **AND** no verifier SHALL be assigned that path

#### Scenario: Selected role has no tagged file

- **WHEN** a role was selected but no changed file is tagged for it
- **THEN** the engine SHALL drop that role from the round
- **AND** the round SHALL proceed with the remaining roles

### Requirement: Triage agent step is retired

The implementation loop SHALL no longer contain a triage agent step, the triage
role SHALL no longer be registered, and its instruction asset SHALL no longer be
pinned by the verification loop. A workflow already in flight SHALL keep the
triage step and role it started with until it is migrated.

#### Scenario: New definitions have no triage step

- **WHEN** a new workflow definition is registered
- **THEN** its implementation loop SHALL contain no triage agent step
- **AND** no triage role SHALL be routable

#### Scenario: In-flight workflow keeps triage

- **WHEN** a workflow started under a definition that includes the triage step
  continues after this change
- **THEN** it SHALL keep its triage step, role, and pinned instruction asset

### Requirement: Retired triage keeps its historical selection rules

The historical triage selection rules remain the compatibility contract for
workflows that started before the triage step was retired: a selection is still
limited to the eligible catalog, still excludes the engine-owned full-suite
role, and is still restricted to a subset of the classifier's selection for the
round. A new-definition workflow derives its scope from tags instead, and SHALL
NOT accept an agent plan as a scope source.

#### Scenario: Legacy triage selection is still bounded

- **WHEN** a workflow pinned to a definition that includes the triage step emits
  a triage plan
- **THEN** the plan SHALL still be validated against the eligible catalog and the
  round's classifier selection
- **AND** the same file-scope rules SHALL apply
