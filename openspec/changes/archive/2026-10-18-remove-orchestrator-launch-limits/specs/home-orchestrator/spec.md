## REMOVED Requirements

### Requirement: Orchestrator launch limits

**Reason**: The developer verified the orchestrator's launch behaviour is
sensible and no longer wants any cap on how many workflows the orchestrator may
spawn, so the active count and the trailing-24 h start count are removed and the
server never refuses an orchestrator start.
**Migration**: Delete the `[agents.orchestrator.limits]` table (and with it
`max_active` and `max_starts_per_day`) from the layered workflow configuration.
This build treats `limits` as an unsupported key and refuses the configuration
until it is gone; no replacement bound exists and none is needed.

#### Scenario: Removed ceiling is unsupported

- **WHEN** a configuration still contains `[agents.orchestrator.limits]`
- **THEN** loading the agents configuration SHALL fail naming `limits` as an
  unsupported key
- **AND** no orchestrator start SHALL be refused or counted for how many
  workflows exist

## MODIFIED Requirements

### Requirement: Orchestrator can shape workflows with blueprints

The orchestrator principal SHALL be allowed to read the blueprint step catalog,
validate blueprints, and start blueprint workflows. Blueprint starts from the
orchestrator SHALL keep the human-review gate pin. The orchestrator session SHALL
be offered tools for these operations and SHALL never submit a manifest
directly.

#### Scenario: Orchestrator validates then starts

- **WHEN** the orchestrator validates a blueprint and then starts it
- **THEN** the started workflow SHALL pin the validated digest
- **AND** its plan, developer and wiki gates SHALL be pinned `always`

#### Scenario: Review-free blueprint

- **WHEN** the orchestrator starts a blueprint that bypasses developer review
- **THEN** the server SHALL refuse it with the compiler's diagnostic
