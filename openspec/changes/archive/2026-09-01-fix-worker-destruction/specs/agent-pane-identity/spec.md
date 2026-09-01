# agent-pane-identity Delta

## MODIFIED Requirements

### Requirement: Reuse before spawn

Before launching a new agent process for a run, the engine SHALL attempt to resolve a live agent for the run's canonical identity — first from the run's persisted handle, then by the canonical agent name — and reuse that agent's pane when it is confirmed alive. A new tab or pane SHALL be created only when no live agent resolves or confirmation fails. This SHALL apply to every launch path, including grouped-round launches anchoring sibling geometry. Pane allocation SHALL record whether the allocated pane was newly created by that allocation call or reused from an existing pane, and SHALL close the pane after a launch failure only when that allocation call created it; a reused pane SHALL never be closed as a side effect of a launch failure on that pane.

#### Scenario: Persistent role relaunches into its existing pane
- **WHEN** a planner, worker, or archive run launches and a live agent with the canonical name already exists
- **THEN** the engine SHALL deliver the new prompt to that existing agent's pane without creating another tab or pane

#### Scenario: Verifier relaunches into its existing pane on a later round
- **WHEN** a new verification round launches for a role whose canonical-name agent is still alive from an earlier round
- **THEN** the engine SHALL deliver the new prompt to that existing pane without creating another tab or pane

#### Scenario: Grouped-round siblings anchor by identity without handles
- **WHEN** a grouped-round launch computes split geometry while sibling runs have no persisted handles but live agents exist under their canonical names
- **THEN** the engine SHALL still resolve those siblings by canonical name and anchor the layout on their panes

#### Scenario: Launch failure on a reused pane does not destroy it
- **WHEN** a run is allocated an existing pane (a live agent's resolved pane, or an existing sibling pane discovered through layout inspection) and `adapter.launch()` subsequently fails for that run
- **THEN** the engine SHALL NOT close that pane, so any other agent still running in it remains untouched

#### Scenario: Launch failure on a newly created pane still cleans it up
- **WHEN** a run is allocated a pane freshly created by that same allocation call (via a new tab or a pane split) and `adapter.launch()` subsequently fails for that run
- **THEN** the engine SHALL close the newly created pane
