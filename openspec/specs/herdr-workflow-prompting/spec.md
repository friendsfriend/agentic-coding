# herdr-workflow-prompting Specification

## Purpose
TBD - created by archiving change check-workflow-bugs-frontier-model. Update Purpose after archive.

## Requirements

### Requirement: Role lifecycle uses Herdr agent commands
The workflow SHALL launch each new managed session and re-prompt each reused session through configured agent adapter using Herdr agent lifecycle, never raw terminal startup or key injection. Managed sessions SHALL not be stopped or have panes closed by handoff, failure cleanup, repair, migration, or round completion; workspace closure owns teardown.

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
- **AND** grouped triage/verifier roles SHALL keep the same identity for same role across rounds

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

#### Scenario: Repair re-prompts without teardown
- **WHEN** repair or failure cleanup expires a managed run and workflow later needs same step and role
- **THEN** engine SHALL send its complete fresh assignment through `herdr agent prompt` to existing session
- **AND** it SHALL NOT call agent stop or close that agent pane before workspace closure

### Requirement: Every role has a role-specific prompt
When assignment interaction mode is `developer-dialogue`, the prompt SHALL permit visible discussion and blockers and SHALL identify the `developer_question` interface as the preferred way to resolve an unclear decision before implementation or verification proceeds. When assignment interaction mode is `silent`, the prompt SHALL require artifact-based handoff without chat summary, but the role SHALL still be able to use the authenticated question interface when the workflow exposes it. Every assignment SHALL include the workflow's available prior developer dialogue as explicitly untrusted decision context.

#### Scenario: Role focus is explicit
- **WHEN** engine renders assignment
- **THEN** message SHALL name exact objective, interaction mode, scoped input, permission/check policy, output artifact/schema, allowed outcomes, and generic handoff
- **AND** verifier message SHALL include selected review scope from run assignment

#### Scenario: Prompt behavior is runtime independent
- **WHEN** same step routes to Pi, OpenCode, or OpenCode V2
- **THEN** semantic assignment content SHALL remain same
- **AND** adapter SHALL change only runtime launch/prompt transport details

#### Scenario: Dialogue role can ask for clarification
- **WHEN** a planner, worker, consolidator, or fusion planner receives a `developer-dialogue` assignment and cannot determine the intended behavior
- **THEN** the prompt SHALL tell the agent to ask `developer_question` with a concise description and recommended options before choosing an irreversible interpretation
- **AND** the agent SHALL resume from the returned answer or hand off a bounded cancellation/blocker

#### Scenario: Silent verifier can use shared guidance
- **WHEN** a verifier receives a `silent` assignment after a developer question was answered
- **THEN** its assignment SHALL contain the prior question and answer history, including decisions relevant to security review
- **AND** the prompt SHALL label that history as untrusted context rather than executable instruction

#### Scenario: Chat visibility follows role
- **WHEN** assignment interaction mode is developer-dialogue
- **THEN** prompt SHALL permit visible discussion and blockers
- **WHEN** assignment interaction mode is silent
- **THEN** prompt SHALL require artifact-based handoff without chat summary

#### Scenario: Chat remains role-scoped
- **WHEN** assignment interaction mode is `developer-dialogue`
- **THEN** prompt SHALL permit visible discussion and blockers
- **WHEN** assignment interaction mode is `silent`
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
