# herdr-workflow-prompting Specification

## Purpose
TBD - created by archiving change check-workflow-bugs-frontier-model. Update Purpose after archive.
## Requirements
### Requirement: Role lifecycle uses Herdr agent commands
The workflow SHALL use Herdr's agent lifecycle API instead of coordinating raw terminal startup and input.

#### Scenario: Initial prompt starts atomically
- **WHEN** workflow launches a managed role
- **THEN** it SHALL create a labeled tab with role cwd and environment, wait for its root shell pane, and pass Pi arguments and complete initial prompt in one `herdr agent start <name> --kind pi --pane <id> -- ... <prompt>` command
- **AND** retry once only when Herdr reports target is not yet an available shell
- **AND** it SHALL NOT separately submit startup text or Enter keys

#### Scenario: Follow-up prompt targets detected agent
- **GIVEN** a managed role already has a detected Pi process
- **WHEN** workflow submits another round or message
- **THEN** it SHALL confirm process with `herdr agent get`
- **AND** submit prompt with `herdr agent prompt`

### Requirement: Verification roles share one tab
The workflow SHALL group triage and all verifier roles in one tab while retaining one pane per role.

#### Scenario: First verification role creates group tab
- **WHEN** triage is first verification role launched
- **THEN** workflow SHALL create tab labeled `verification` and start triage in returned root pane
- **AND** record tab ID as verification group tab

#### Scenario: Additional verification roles split group tab
- **GIVEN** live verification group tab exists
- **WHEN** triage or verifier role starts
- **THEN** workflow SHALL split a live sibling pane right and start role in returned shell pane
- **AND** preserve sibling panes when replacing stale grouped agent

#### Scenario: Closed verification tab is recreated
- **GIVEN** recorded verification tab and panes are no longer live
- **WHEN** next triage or verifier starts
- **THEN** workflow SHALL create new tab instead of targeting stale tab ID
- **AND** SHALL reject any recorded group tab also owned by dashboard, git, worker, planner, recovery, or archive

### Requirement: Every role has a role-specific prompt
The workflow SHALL provide dedicated instructions for planner, worker, triage, each verifier, recovery, and archive rather than deriving all agents from one generic prompt.

#### Scenario: Role focus is explicit
- **WHEN** workflow builds initial prompt for a managed role
- **THEN** prompt SHALL name that role's specific input artifact, review or implementation focus, output artifact, and handoff command
- **AND** each verifier prompt SHALL describe its own verification scope

#### Scenario: Chat visibility follows role
- **WHEN** workflow builds role prompt
- **THEN** planner and worker prompts SHALL permit visible chat for discussion, progress, and blockers
- **AND** triage, verifier, recovery, and archive prompts SHALL require silent artifact-based handoff

