## MODIFIED Requirements

### Requirement: Role lifecycle uses Herdr agent commands
The workflow SHALL launch each managed run through configured agent adapter using Herdr agent lifecycle, never raw terminal startup or key injection.

#### Scenario: Initial prompt starts atomically
- **WHEN** workflow outbox requests managed agent launch
- **THEN** adapter SHALL create required labeled tab/pane topology with run environment, wait for foreground shell, and call `herdr agent start` with runtime kind and adapter arguments
- **AND** adapter SHALL retry once only when Herdr reports target pane is not yet available shell

#### Scenario: Initial assignment is delivered
- **WHEN** Herdr agent start succeeds
- **THEN** adapter SHALL confirm detected process with `herdr agent get`
- **AND** submit complete rendered assignment message through `herdr agent prompt`
- **AND** it SHALL NOT use raw pane text, Enter keys, runtime skills, or slash skill invocation

#### Scenario: Follow-up prompt targets detected agent
- **GIVEN** adapter permits session reuse and managed agent remains detected
- **WHEN** engine assigns later run to session
- **THEN** adapter SHALL confirm process with `herdr agent get`
- **AND** submit complete new assignment through `herdr agent prompt`
- **AND** detection SHALL use the same agent identity that was used to launch the role's prior run, so the lookup can succeed

#### Scenario: Persistent single-role identity remains stable across generations
- **GIVEN** a single-role step (planner, worker, or archive) re-enters itself or is re-entered through a review-comment, reject, blocked, or failed transition within the same workflow instance
- **WHEN** engine computes the Herdr agent identity for the new run
- **THEN** the computed identity SHALL be identical to the identity used for the role's previous run in that workflow instance
- **AND** engine SHALL NOT derive that identity from the per-run identifier
- **AND** grouped triage/verifier roles SHALL keep a per-run identity unaffected by this scenario
