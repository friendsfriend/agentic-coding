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

### Requirement: Triage has its own tab and each verifier role has its own tab
The workflow SHALL run triage in its own tab labeled `triage` and SHALL give every verifier role its own tab labeled with a shortened form of that role's name and current run status glyph. Verifier roles SHALL NOT share a tab and SHALL NOT split a shared verifier pane into a grid; each verifier pane SHALL occupy the full tab height. Verifier pane geometry SHALL never anchor on the triage pane, and a verifier tab SHALL be reused across verification rounds and fix loops rather than duplicated.

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
- **THEN** workflow SHALL create a tab labeled `<status glyph> <shortened role>` and start the verifier in the returned root pane at full tab height
- **AND** the shortened role SHALL compress the role's `-verifier` suffix to `-v…` (for example `quality-v…`), leaving non-verifier role names unchanged
- **AND** record the returned tab ID against that role

#### Scenario: Additional verifier roles each get their own tab
- **GIVEN** a live tab exists for one verifier role
- **WHEN** another verifier role launches
- **THEN** workflow SHALL create a separate tab labeled with the second role's shortened name at full tab height
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
