# Spec Delta

## ADDED Requirements

### Requirement: Engine reads family traits instead of repository family identifiers

The engine SHALL read every repository code-change family property it decides on
— in the runtime, step behaviors, the start boundary and effects — from the
pinned definition's effective traits or manifest policy, and SHALL NOT compare
the workflow definition identifier against a repository code-change family
name. Step behavior hooks SHALL receive the effective traits as an input. The
behavior of every built-in family at every registered tier SHALL be unchanged.

#### Scenario: Definition with an unknown id behaves by its traits

- **WHEN** a registered repository definition with a new id declares
  `changeArtifacts: none` and `delivery: none`
- **THEN** its implementation step SHALL run in change-free mode
- **AND** its completion step SHALL offer only `close`

#### Scenario: Family id literal is rejected

- **WHEN** a module outside the definitions catalog compares a definition id to a
  repository code-change family name
- **THEN** the architecture test SHALL fail naming the module
