# Spec Delta

## ADDED Requirements

### Requirement: Classifier pool routing for classifiable steps

For a workflow definition with classifiable steps, the system SHALL route each classifiable step from the pool entry selected by the classifier, falling back to that pool's tagged default, instead of from a preset step/role assignment. A single-step selection SHALL apply to every route of that step, so one `core.verification` pool covers all selected verifier roles. Fusion planning SHALL route its `planner-1..N` roles from the classified roster, with the `fusion.plan` tagged defaults as the pre-classification fallback. Every profile resolved this way SHALL be preflighted for its step's requirements, and a `core.verification` route SHALL be rewritten to a read-only profile before launch.

#### Scenario: Classifiable step uses its pool selection

- **WHEN** the classifier selects a pool entry for a classifiable step
- **THEN** each route of that step SHALL use the entry's profile
- **AND** a preset step or role assignment for that step SHALL NOT override the selection

#### Scenario: Verification routes share one selection

- **WHEN** `core.verification` has multiple verifier-role routes and the classifier selects one profile
- **THEN** every verifier-role route SHALL use that profile
- **AND** each resolved route SHALL retain the read-only requirement

#### Scenario: Unclassified classifiable step falls back

- **WHEN** no classifier selection is applied to a classifiable step before it runs
- **THEN** that step's routes SHALL use the pool's tagged default entry

#### Scenario: Resolved pool profile fails preflight

- **WHEN** a profile resolved from a pool cannot provide its step's required capabilities or model availability
- **THEN** the routing update SHALL fail and record attention without launching the step's agent
