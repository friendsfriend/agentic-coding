# herdr-workflow-prompting Specification

## Purpose
TBD - created by archiving change check-workflow-bugs-frontier-model. Update Purpose after archive.

## Requirements

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
The workflow SHALL render each run message from one common protocol Markdown, registered step instruction assets, and validated dynamic assignment rather than runtime-specific skill documents. Planning-role instructions SHALL distinguish focused, change-relevant validation that belongs in implementation tasks from the complete repository test suite owned by the automatically launched test-verifier.

#### Scenario: Role focus is explicit
- **WHEN** engine renders assignment
- **THEN** message SHALL name exact objective, interaction mode, scoped input, permission/check policy, output artifact/schema, allowed outcomes, and generic handoff
- **AND** verifier message SHALL include selected review scope from run assignment

#### Scenario: Prompt behavior is runtime independent
- **WHEN** same step routes to Pi, OpenCode, or OpenCode V2
- **THEN** semantic assignment content SHALL remain same
- **AND** adapter SHALL change only runtime launch/prompt transport details

#### Scenario: Chat visibility follows role
- **WHEN** assignment interaction mode is developer-dialogue
- **THEN** prompt SHALL permit visible discussion and blockers
- **WHEN** assignment interaction mode is silent
- **THEN** prompt SHALL require artifact-based handoff without chat summary

#### Scenario: Planner assigns focused validation only
- **WHEN** a planning role defines implementation tasks or required validation for an OpenSpec change
- **THEN** its instructions SHALL require focused checks that cover the changed behavior
- **AND** its instructions SHALL prohibit requiring the worker to run the complete repository test suite
- **AND** its instructions SHALL identify the complete suite as owned by the workflow test-verifier after implementation and selected verification runs complete

#### Scenario: Fusion planning preserves test ownership
- **WHEN** a fusion planner or consolidation role proposes or reconciles implementation validation for an OpenSpec change
- **THEN** the resulting plan SHALL preserve focused worker checks for changed behavior
- **AND** it SHALL not add a complete-suite worker task that duplicates the workflow test-verifier run
