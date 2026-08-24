# agent-pane-identity Specification

## Purpose
Gives every workflow-managed agent a deterministic, collision-free identity and guarantees that launches reuse the agent's existing pane instead of spawning duplicates, so long-running workflows stay stable across retries, generations, and engine restarts.
## Requirements
### Requirement: Deterministic unique agent names
Each workflow-managed agent SHALL have one canonical name derived from its workflow change ID, step, and role (plus round discriminator for grouped one-shot roles). The derivation SHALL be injective within the Herdr runtime: two different workflows, steps, or roles SHALL never map to the same live agent name. The discriminating identity (change + role) SHALL NOT be truncated away to satisfy runtime name limits.

#### Scenario: Long change IDs do not collide
- **WHEN** two workflows run for change IDs that share the same leading characters up to any legacy truncation width
- **THEN** their persistent-role agents SHALL still receive distinct canonical names and SHALL never resolve to each other's panes

#### Scenario: Name derivation is stable across restarts
- **WHEN** the engine re-derives an agent's canonical name after a restart or retry
- **THEN** the same workflow, step, role, and round SHALL produce the identical name as before

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

### Requirement: Handle staleness recovers by identity, not geometry
A persisted run handle whose pane has died SHALL be detected and discarded without discarding the agent identity: the engine SHALL re-resolve the agent by its canonical name and adopt the agent's current pane. Resolution SHALL distinguish finding the agent (by canonical name) from communicating with it (by its live pane id), and stored pane ids SHALL never be treated as proof of liveness on their own.

#### Scenario: Stale handle after pane death
- **WHEN** a run's stored pane id no longer corresponds to a live pane but an agent with the canonical name is alive elsewhere
- **THEN** the engine SHALL update the run's handle to the agent's current pane id and reuse that pane

#### Scenario: Dead agent falls through to a clean launch
- **WHEN** neither the stored handle nor the canonical name resolves to a live agent
- **THEN** the engine SHALL launch a new agent under the canonical name and persist the resulting handle

### Requirement: Telemetry bridge derives run environment from the naming scheme
The runtime telemetry bridge SHALL recover the run environment using the same canonical naming scheme the engine uses, not positional heuristics about the agent name's suffix shape; recovery SHALL succeed for both persistent-role and round-scoped agent names.

#### Scenario: Persistent-role bridge recovers run env
- **WHEN** a reused persistent-role agent starts and its pane shell lost the exported run environment
- **THEN** the bridge SHALL locate and restore the correct run.env for that agent's workflow without relying on an 8-hex-character name suffix

### Requirement: Round-stable identity for grouped roles
Grouped triage and verification roles SHALL derive their canonical agent name from the workflow change ID, definition ID, step ID, and role only — without any run- or round-scoped discriminator. The same role in a later round of the same workflow SHALL resolve to the identical canonical name as in earlier rounds. Distinct roles, steps, and workflows SHALL still never share a live agent name.

#### Scenario: Verifier keeps one identity across rounds
- **WHEN** a verification fix loop re-enters `core.verification` and creates new runs for the same verifier role
- **THEN** the new runs' canonical agent names SHALL equal the previous round's names for that role

#### Scenario: Roles and workflows remain distinct
- **WHEN** two different verifier roles run for the same step, or the same role runs for two workflows whose change IDs share a leading prefix
- **THEN** their canonical agent names SHALL differ

