## REMOVED Requirements

### Requirement: Triage has its own tab and verifiers share one tab
**Reason**: Verifiers no longer share one tab. Each verifier role now owns a full-height tab so several verifier roles are distinguishable and each gets the whole tab height.
**Migration**: No action for users. The workflow reuses an in-flight verifier's live agent and its existing pane until the workspace closes; every allocation after this change resolves a per-role tab.

## ADDED Requirements

### Requirement: Triage has its own tab and each verifier role has its own tab
The workflow SHALL run triage in its own tab labeled `triage` and SHALL give every verifier role its own tab labeled with that role's name and current run status glyph. Verifier roles SHALL NOT share a tab and SHALL NOT split a shared verifier pane into a grid; each verifier pane SHALL occupy the full tab height. Verifier pane geometry SHALL never anchor on the triage pane, and a verifier tab SHALL be reused across verification rounds and fix loops rather than duplicated.

#### Scenario: Triage creates its own tab
- **WHEN** the triage run is launched
- **THEN** workflow SHALL create a tab labeled `triage` and start triage in the returned root pane
- **AND** record the tab ID as the triage tab

#### Scenario: Closed triage tab is recreated
- **GIVEN** a recorded `triage` tab and its panes are no longer live
- **WHEN** triage next starts
- **THEN** workflow SHALL create a new `triage` tab instead of targeting the stale tab ID
- **AND** SHALL reject any recorded agent tab also owned by dashboard, git, worker, planner, recovery, or archive

#### Scenario: First verifier role creates its own tab
- **WHEN** a verifier role is launched and no live agent resolves for it
- **THEN** workflow SHALL create a tab labeled `<status glyph> <role>` and start the verifier in the returned root pane at full tab height
- **AND** record the returned tab ID against that role

#### Scenario: Additional verifier roles each get their own tab
- **GIVEN** a live tab exists for one verifier role
- **WHEN** another verifier role launches
- **THEN** workflow SHALL create a separate tab labeled with the second role's name at full tab height
- **AND** SHALL NOT split the first verifier's tab or place the second role in the first role's pane
- **AND** SHALL NOT anchor verifier pane geometry on the triage pane

#### Scenario: Verifier tab is reused across rounds
- **GIVEN** a verifier role launched in an earlier verification round and its canonical agent is still live
- **WHEN** the same role launches in a later verification round or fix loop
- **THEN** workflow SHALL resolve the existing live agent by its stable identity and reuse that agent's pane and tab
- **AND** SHALL NOT create a second tab for that role

#### Scenario: Closed verifier tab is recreated
- **GIVEN** a recorded verifier role tab and its panes are no longer live
- **WHEN** that role next starts
- **THEN** workflow SHALL create a new tab for that role instead of targeting the stale tab ID
- **AND** SHALL reject any recorded agent tab also owned by dashboard, git, worker, planner, recovery, or archive

#### Scenario: Repair re-prompts without teardown
- **WHEN** repair or failure cleanup expires a managed run and workflow later needs same step and role
- **THEN** engine SHALL send its complete fresh assignment through `herdr agent prompt` to existing session
- **AND** it SHALL NOT call agent stop or close that agent pane before workspace closure
