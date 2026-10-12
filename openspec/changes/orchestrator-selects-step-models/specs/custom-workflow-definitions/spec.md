## MODIFIED Requirements

### Requirement: Custom definitions meet the newest-tier invariants

A custom definition SHALL be accepted only when it passes the registry's
structural validation, pins exact step references, declares a non-empty label
the view projection can render, declares a manifest policy with family traits
for a repository code-change target, contains no retired routing step, and
places the stage gate in front of every gated stage. A rejected definition SHALL
NOT be stored, and the rejection SHALL name the violated invariant.

#### Scenario: Retired routing step is refused

- **WHEN** a custom manifest lists `core.route-implementation`
- **THEN** it SHALL be rejected naming that step

#### Scenario: Gated stage without its gate is refused

- **WHEN** a custom manifest places a gated stage without the stage's gate step in front of it
- **THEN** it SHALL be rejected naming the missing gate
