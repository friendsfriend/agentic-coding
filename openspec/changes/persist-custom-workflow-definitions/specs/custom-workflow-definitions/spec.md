# Spec Delta

## Purpose

Store custom workflow definitions durably beside the workflows that pin them,
re-validate them on every load, and resolve pinned workflows against them.

## ADDED Requirements

### Requirement: Custom definitions are stored per workflow target

The workflow store SHALL persist custom workflow definitions, keyed by digest,
in the same target store as the workflows that pin them. A custom definition SHALL
use the reserved `custom.` identifier namespace and version 1, and its identifier
SHALL be derived from its digest. A built-in definition SHALL NOT use the
`custom.` namespace. Storing an identical manifest twice SHALL yield the same
identity.

#### Scenario: Same manifest stored twice

- **WHEN** the same manifest is stored twice in one target
- **THEN** both operations SHALL return the same identifier and digest
- **AND** one stored row SHALL exist

### Requirement: Custom definitions meet the newest-tier invariants

A custom definition SHALL be accepted only when it passes the registry's
structural validation, pins exact step references, declares a manifest policy
with family traits for a repository code-change target, places a routing step
immediately before every classifiable agent step, and places the stage gate in
front of every gated stage. A rejected definition SHALL NOT be stored, and the
rejection SHALL name the violated invariant.

#### Scenario: Missing routing step

- **WHEN** a custom manifest enters `core.implementation` without its routing step
- **THEN** it SHALL be rejected naming the missing routing step

### Requirement: Pinned custom workflows resolve after restart

A workflow pinned to a custom definition SHALL resolve that definition from its
target store in any later process, after re-validating it against the current
step catalog. If the stored definition no longer validates, the workflow SHALL be
blocked before further mutation or effect execution with a diagnostic naming the
failing step, exactly like a built-in pin mismatch.

#### Scenario: Restart

- **WHEN** a custom workflow is started and the engine process restarts
- **THEN** the next command SHALL resolve the stored definition and dispatch

#### Scenario: Step version removed

- **WHEN** a stored definition references a step version that is no longer
  registered
- **THEN** its workflows SHALL be blocked with a diagnostic naming that step

### Requirement: Operator can define and start a custom workflow

The workflow CLI SHALL validate and store a custom definition from a manifest
file for a repository, printing its identifier and digest, and SHALL start a
workflow by a stored custom identifier.

#### Scenario: Define then start

- **WHEN** the operator defines a valid manifest and starts a workflow with the
  printed identifier
- **THEN** the workflow SHALL pin that identifier, version 1 and digest
