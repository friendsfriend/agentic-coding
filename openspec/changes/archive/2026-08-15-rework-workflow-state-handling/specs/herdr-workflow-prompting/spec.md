## MODIFIED Requirements

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

### Requirement: Every role has a role-specific prompt
The workflow SHALL render each run message from one common protocol Markdown, registered step instruction assets, and validated dynamic assignment rather than runtime-specific skill documents.

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
