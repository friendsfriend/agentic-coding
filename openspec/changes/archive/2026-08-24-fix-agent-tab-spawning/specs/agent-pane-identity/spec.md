# agent-pane-identity Delta

## ADDED Requirements

### Requirement: Round-stable identity for grouped roles
Grouped triage and verification roles SHALL derive their canonical agent name from the workflow change ID, definition ID, step ID, and role only — without any run- or round-scoped discriminator. The same role in a later round of the same workflow SHALL resolve to the identical canonical name as in earlier rounds. Distinct roles, steps, and workflows SHALL still never share a live agent name.

#### Scenario: Verifier keeps one identity across rounds
- **WHEN** a verification fix loop re-enters `core.verification` and creates new runs for the same verifier role
- **THEN** the new runs' canonical agent names SHALL equal the previous round's names for that role

#### Scenario: Roles and workflows remain distinct
- **WHEN** two different verifier roles run for the same step, or the same role runs for two workflows whose change IDs share a leading prefix
- **THEN** their canonical agent names SHALL differ

## MODIFIED Requirements

### Requirement: Reuse before spawn
Before launching a new agent process for a run, the engine SHALL attempt to resolve a live agent for the run's canonical identity — first from the run's persisted handle, then by the canonical agent name — and reuse that agent's pane when it is confirmed alive. A new tab or pane SHALL be created only when no live agent resolves or confirmation fails. This SHALL apply to every launch path, including grouped-round launches anchoring sibling geometry.

#### Scenario: Persistent role relaunches into its existing pane
- **WHEN** a planner, worker, or archive run launches and a live agent with the canonical name already exists
- **THEN** the engine SHALL deliver the new prompt to that existing agent's pane without creating another tab or pane

#### Scenario: Verifier relaunches into its existing pane on a later round
- **WHEN** a new verification round launches for a role whose canonical-name agent is still alive from an earlier round
- **THEN** the engine SHALL deliver the new prompt to that existing pane without creating another tab or pane

#### Scenario: Grouped-round siblings anchor by identity without handles
- **WHEN** a grouped-round launch computes split geometry while sibling runs have no persisted handles but live agents exist under their canonical names
- **THEN** the engine SHALL still resolve those siblings by canonical name and anchor the layout on their panes

